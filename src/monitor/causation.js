import { db, dbEnabled } from '../db/index.js';

/**
 * determines whether a parachain fork was caused by a relay chain fork
 * or by collator contention.
 *
 * when a parachain fork is detected, we fetch the relay parent from each
 * competing block's validation data. if they reference different relay parents,
 * the fork was caused by the relay chain forking.
 */
export class ForkCausation {
	constructor(parachainCtx, relayChainCtx, m) {
		this.parachain = parachainCtx;
		this.relayChain = relayChainCtx;
		this.m = m;

		// hook into the parachain's fork detector
		const originalOnForkDetected = this.parachain.forkDetector.onForkDetected.bind(
			this.parachain.forkDetector
		);
		this.parachain.forkDetector.onForkDetected = async (height, blocksAtHeight) => {
			await originalOnForkDetected(height, blocksAtHeight);
			await this.analyzeForkCause(height, blocksAtHeight);
		};
	}

	/**
	 * analyze the cause of a parachain fork by comparing relay parents.
	 */
	async analyzeForkCause(height, blocksAtHeight) {
		const blocks = Array.from(blocksAtHeight.values());
		if (blocks.length < 2) return;

		// try to get relay parent for each competing block
		const relayParents = await Promise.all(
			blocks.map(block => this.getRelayParent(block))
		);

		const validRelayParents = relayParents.filter(rp => rp !== null);
		if (validRelayParents.length < 2) {
			console.log(`[${this.parachain.name}] could not determine relay parents for fork at height ${height}`);
			return;
		}

		// compare relay parents by NUMBER first, then by hash at the same number.
		// - same relay number, same hash → collator_contention (same relay context)
		// - same relay number, different hash → relay_fork (relay chain forked at that height)
		// - different relay numbers → collator_contention (collators built at different times, normal)
		const relayNumbers = validRelayParents.map(rp => rp.number);
		const relayHashes = validRelayParents.map(rp => rp.hash);
		const uniqueNumbers = new Set(relayNumbers.filter(n => n !== null));
		const uniqueHashes = new Set(relayHashes.filter(h => h !== null));
		let cause;
		let relayHeight = null;

		if (uniqueNumbers.size === 1 && uniqueHashes.size > 1) {
			// same relay height, different block hashes → actual relay chain fork
			cause = 'relay_fork';
			relayHeight = relayNumbers.find(n => n !== null);
			console.log(
				`[${this.parachain.name}] fork at height ${height} caused by relay chain fork` +
				` at relay height ${relayHeight} (${uniqueHashes.size} competing relay blocks)`
			);
			this.m.parachain_forks_relay_caused_total.inc({
				chain: this.parachain.name,
				relay_chain: this.relayChain.name,
			});
		} else if (uniqueNumbers.size > 1) {
			// different relay heights → collators built at different times, not a relay fork
			cause = 'collator_contention';
			const numbers = Array.from(uniqueNumbers).sort((a, b) => a - b);
			console.log(
				`[${this.parachain.name}] fork at height ${height} caused by collator contention ` +
				`(different relay heights: ${numbers.join(' vs ')})`
			);
		} else {
			// same relay number, same hash → both collators produced for same relay context
			cause = 'collator_contention';
			console.log(
				`[${this.parachain.name}] fork at height ${height} caused by collator contention ` +
				`(same relay parent #${relayNumbers[0]})`
			);
		}

		this.m.parachain_fork_cause_total.inc({
			chain: this.parachain.name,
			cause,
		});

		// update the database if enabled
		if (dbEnabled()) {
			await db().query(
				`UPDATE fork_events SET cause = $1, relay_height = $2
				 WHERE id = (
				   SELECT id FROM fork_events
				   WHERE chain = $3 AND block_number = $4 AND cause IS NULL
				   ORDER BY detected_at DESC LIMIT 1
				 )`,
				[cause, relayHeight, this.parachain.name, height]
			).catch(err => console.error(`failed to update fork cause: ${err.message}`));

			for (let i = 0; i < blocks.length; i++) {
				if (relayParents[i]) {
					await db().query(
						`UPDATE fork_blocks SET relay_parent = $1 WHERE block_hash = $2`,
						[relayParents[i].hash, blocks[i].hash]
					).catch(() => {});
				}
			}
		}

		// update in-memory block records with relay parent
		for (let i = 0; i < blocks.length; i++) {
			if (relayParents[i]) {
				blocks[i].relayParent = relayParents[i].hash;
			}
		}
	}

	/**
	 * get the relay parent hash and number for a parachain block.
	 * queries parachainSystem.validationData storage at the block hash.
	 *
	 * @returns {{ hash: string, number: number }|null}
	 */
	async getRelayParent(block) {
		// find a connected api for the parachain
		const conn = this.parachain.connections.find(c => c.connected);
		if (!conn) return null;

		try {
			const validationData = await conn.api.query.parachainSystem.validationData.at(block.hash);
			if (validationData.isSome) {
				const data = validationData.unwrap();
				return {
					hash: data.relayParentStorageRoot.toHex(),
					number: data.relayParentNumber.toNumber(),
				};
			}

			// fallback: try reading the relay parent number directly
			const relayNumber = await conn.api.query.parachainSystem.lastRelayChainBlockNumber.at(block.hash);
			if (relayNumber) {
				return {
					hash: null,
					number: relayNumber.toNumber(),
				};
			}
		} catch (e) {
			// validationData may not be available for non-finalized blocks on some nodes
			try {
				// alternative: decode from the set_validation_data inherent in the block body
				return await this.getRelayParentFromInherent(conn.api, block.hash);
			} catch (e2) {
				return null;
			}
		}

		return null;
	}

	/**
	 * fallback: extract relay parent from the set_validation_data inherent extrinsic.
	 */
	async getRelayParentFromInherent(api, blockHash) {
		const block = await api.rpc.chain.getBlock(blockHash);
		const extrinsics = block.block.extrinsics;

		// set_validation_data is typically the first inherent
		for (const ext of extrinsics) {
			if (
				ext.method.section === 'parachainSystem' &&
				ext.method.method === 'setValidationData'
			) {
				const args = ext.method.args[0];
				const relayParentNumber = args.validationData?.relayParentNumber?.toNumber?.()
					|| args.relayParentNumber?.toNumber?.();
				const relayParentHash = args.validationData?.relayParentStorageRoot?.toHex?.()
					|| args.relayParentStorageRoot?.toHex?.();

				if (relayParentNumber || relayParentHash) {
					return {
						hash: relayParentHash || null,
						number: relayParentNumber || null,
					};
				}
			}
		}

		return null;
	}
}
