import { db, dbEnabled } from '../db/index.js';

/**
 * determines the cause of parachain forks by analyzing:
 * - whether the same or different authors produced competing blocks
 * - whether they reference the same or different relay chain blocks
 * - whether they share the same parachain parent
 *
 * cause categories:
 * - relay_fork: relay chain forked, different relay block hashes at same height
 * - relay_fork_same_author: relay fork, but same collator produced on both branches
 * - collator_contention: different collators competing (same or different relay context)
 * - double_production: same collator produced twice on same relay context, same parent
 * - double_production_reorg: same collator, same relay context, different para parent
 * - double_production_timing: same collator built at different relay heights
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

	async analyzeForkCause(height, blocksAtHeight) {
		const blocks = Array.from(blocksAtHeight.values());
		if (blocks.length < 2) return;

		// fetch relay parent for each competing block
		const relayParents = await Promise.all(
			blocks.map(block => this.getRelayParent(block))
		);

		let validRelayParents = relayParents.filter(rp => rp !== null);

		// retry once after a short delay if we couldn't get all relay parents
		// (block state may not be available on nodes immediately after import)
		if (validRelayParents.length < blocks.length) {
			await new Promise(r => setTimeout(r, 2000));
			const retryParents = await Promise.all(
				blocks.map((block, i) => relayParents[i] ? relayParents[i] : this.getRelayParent(block))
			);
			for (let i = 0; i < retryParents.length; i++) {
				if (retryParents[i]) relayParents[i] = retryParents[i];
			}
			validRelayParents = relayParents.filter(rp => rp !== null);
		}

		if (validRelayParents.length < 2) {
			console.log(`[${this.parachain.name}] could not determine relay parents for fork at height ${height}`);
			return;
		}

		// analyze the three dimensions
		const authors = blocks.map(b => b.authorName || b.author || 'unknown');
		const parentHashes = blocks.map(b => b.parentHash);
		const relayNumbers = validRelayParents.map(rp => rp.number);
		const relayHashes = validRelayParents.map(rp => rp.hash);

		const uniqueAuthors = new Set(authors);
		const uniqueParents = new Set(parentHashes);
		const uniqueRelayNumbers = new Set(relayNumbers.filter(n => n !== null));
		const uniqueRelayHashes = new Set(relayHashes.filter(h => h !== null));

		const sameAuthor = uniqueAuthors.size === 1;
		const sameParent = uniqueParents.size === 1;
		const sameRelayNumber = uniqueRelayNumbers.size <= 1;
		const sameRelayHash = uniqueRelayHashes.size <= 1;

		// determine cause
		let cause;
		let relayHeight = null;

		if (sameRelayNumber && !sameRelayHash) {
			// relay chain forked at this height
			relayHeight = relayNumbers.find(n => n !== null);
			cause = sameAuthor ? 'relay_fork_same_author' : 'relay_fork';
		} else if (sameAuthor) {
			// same collator produced multiple blocks
			if (!sameRelayNumber) {
				cause = 'double_production_timing';
			} else if (!sameParent) {
				cause = 'double_production_reorg';
			} else {
				cause = 'double_production';
			}
		} else {
			cause = 'collator_contention';
		}

		const details = {
			authors: authors,
			relay_numbers: relayNumbers,
			relay_hashes: relayHashes.map(h => h ? h.slice(0, 18) + '...' : null),
			parent_hashes: parentHashes.map(h => h.slice(0, 18) + '...'),
			same_author: sameAuthor,
			same_relay_number: sameRelayNumber,
			same_relay_hash: sameRelayHash,
			same_parent: sameParent,
		};

		const relayInfo = sameRelayNumber
			? `relay #${relayNumbers[0]}${sameRelayHash ? ' same hash' : ' DIFFERENT hashes'}`
			: `relay ${Array.from(uniqueRelayNumbers).sort((a, b) => a - b).join(' vs ')}`;

		console.log(
			`[${this.parachain.name}] fork at height ${height}: ${cause} ` +
			`(${sameAuthor ? 'same author' : authors.join(' vs ')}, ` +
			`${relayInfo}, ` +
			`${sameParent ? 'same parent' : 'different parents'})`
		);

		// update in-memory ring buffer entry
		const recentEntry = this.parachain.forkDetector.recentForks
			.findLast(f => f.chain === this.parachain.name && f.block_number === height);
		if (recentEntry) {
			recentEntry.cause = cause;
			recentEntry.relay_height = relayHeight;
			recentEntry.same_author = sameAuthor;
			recentEntry.same_relay = sameRelayNumber && sameRelayHash;
			recentEntry.same_parent = sameParent;
			recentEntry.authors = authors;

		}

		// update metrics
		this.m.parachain_fork_cause_total.inc({
			chain: this.parachain.name,
			cause,
		});

		if (cause === 'relay_fork' || cause === 'relay_fork_same_author') {
			this.m.parachain_forks_relay_caused_total.inc({
				chain: this.parachain.name,
				relay_chain: this.relayChain.name,
			});
		}

		// update database
		if (dbEnabled()) {
			await db().query(
				`UPDATE fork_events SET cause = $1, relay_height = $2,
				 same_author = $5, same_relay = $6, same_parent = $7, details = $8
				 WHERE id = (
				   SELECT id FROM fork_events
				   WHERE chain = $3 AND block_number = $4 AND cause IS NULL
				   ORDER BY detected_at DESC LIMIT 1
				 )`,
				[cause, relayHeight, this.parachain.name, height,
				 sameAuthor, sameRelayNumber && sameRelayHash, sameParent,
				 JSON.stringify(details)]
			).catch(err => console.error(`failed to update fork cause: ${err.message}`));

			for (let i = 0; i < blocks.length; i++) {
				if (relayParents[i]) {
					await db().query(
						`UPDATE fork_blocks SET relay_parent = $1, relay_number = $2 WHERE block_hash = $3`,
						[relayParents[i].hash, relayParents[i].number, blocks[i].hash]
					).catch(() => {});
				}
			}
		}

		// update in-memory block records
		for (let i = 0; i < blocks.length; i++) {
			if (relayParents[i]) {
				blocks[i].relayParent = relayParents[i].hash;
				blocks[i].relayNumber = relayParents[i].number;
			}
		}
	}

	/**
	 * get the relay parent hash and number for a parachain block.
	 * queries parachainSystem.validationData storage at the block hash.
	 */
	async getRelayParent(block) {
		// try all connected nodes, not just the first one
		const connections = this.parachain.connections.filter(c => c.connected);
		if (!connections.length) return null;

		for (const conn of connections) {
			try {
				const validationData = await conn.api.query.parachainSystem.validationData.at(block.hash);
				if (validationData.isSome) {
					const data = validationData.unwrap();
					return {
						hash: data.relayParentStorageRoot.toHex(),
						number: data.relayParentNumber.toNumber(),
					};
				}

				const relayNumber = await conn.api.query.parachainSystem.lastRelayChainBlockNumber.at(block.hash);
				if (relayNumber) {
					return { hash: null, number: relayNumber.toNumber() };
				}
			} catch (e) {
				try {
					return await this.getRelayParentFromInherent(conn.api, block.hash);
				} catch (e2) {
					// try next node
					continue;
				}
			}
		}

		return null;
	}

	async getRelayParentFromInherent(api, blockHash) {
		const block = await api.rpc.chain.getBlock(blockHash);
		const extrinsics = block.block.extrinsics;

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
					return { hash: relayParentHash || null, number: relayParentNumber || null };
				}
			}
		}

		return null;
	}
}
