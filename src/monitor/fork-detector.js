import { insertForkBlock, insertForkEvent } from '../db/queries.js';

const MAX_RECENT_FORKS = 5000;

export class ForkDetector {
	constructor(blockTree, m, chainName) {
		this.blockTree = blockTree;
		this.m = m;
		this.chainName = chainName;
		/** @type {Map<number, boolean>} tracks heights where we already recorded a fork event */
		this.recordedForks = new Map();
		/** @type {Array} in-memory ring buffer of recent fork events */
		this.recentForks = [];
		/** @type {number} total fork count since startup */
		this.totalForkCount = 0;
	}

	/**
	 * count forks detected within the last N milliseconds
	 */
	countForksSince(windowMs) {
		const cutoff = Date.now() - windowMs;
		let count = 0;
		// iterate from end (newest first) and stop when older than cutoff
		for (let i = this.recentForks.length - 1; i >= 0; i--) {
			const t = new Date(this.recentForks[i].detected_at).getTime();
			if (t < cutoff) break;
			count++;
		}
		return count;
	}

	/**
	 * called each time a new block header arrives from any node.
	 * detects forks and records metrics + db entries.
	 * @returns {{ record: import('./block-tree.js').BlockRecord, forked: boolean }}
	 */
	async onNewBlock(hash, number, parentHash, author, authorName, relayParent, nodeName, extra = {}) {
		const { record, isNew } = this.blockTree.addBlock(
			hash, number, parentHash, author, authorName, relayParent, nodeName, extra
		);

		if (!isNew) return { record, forked: false };

		this.m.blocks_imported_total.inc({ chain: this.chainName, node: nodeName });

		const blocksAtHeight = this.blockTree.getBlocksAtHeight(number);
		const forked = blocksAtHeight.size > 1;

		if (forked && !this.recordedForks.get(number)) {
			this.recordedForks.set(number, true);
			await this.onForkDetected(number, blocksAtHeight);
		} else if (forked) {
			// additional competing block at an already-forked height
			await this.onForkUpdated(number, blocksAtHeight);
		}

		return { record, forked };
	}

	async onForkDetected(height, blocksAtHeight) {
		const blocks = Array.from(blocksAtHeight.values());
		const authors = blocks.map(b => b.authorName || b.author || 'unknown');
		const depth = this.blockTree.measureForkDepth(height);

		console.log(
			`[${this.chainName}] fork at height ${height}: ` +
			`${blocks.length} competing blocks by ${authors.join(' vs ')}, depth ${depth}`
		);

		this.m.fork_events_total.inc({ chain: this.chainName });
		this.m.fork_depth.observe({ chain: this.chainName }, depth);
		this.m.active_fork_heights.inc({ chain: this.chainName });

		// in-memory ring buffer (always available, even without db)
		this.totalForkCount++;
		this.recentForks.push({
			chain: this.chainName,
			block_number: height,
			competing_count: blocks.length,
			authors,
			cause: null,
			relay_height: null,
			depth,
			same_author: null,
			same_relay: null,
			same_parent: null,
			resolved: false,
			resolved_hash: null,
			detected_at: new Date().toISOString(),
			resolved_at: null,
		});
		if (this.recentForks.length > MAX_RECENT_FORKS) {
			this.recentForks.shift();
		}

		for (const block of blocks) {
			if (block.author) {
				this.m.author_fork_blocks_total.inc({
					chain: this.chainName,
					author: block.authorName || block.author
				});
			}
		}

		// persist to db
		for (const block of blocks) {
			await insertForkBlock({
				chain: this.chainName,
				blockNumber: block.number,
				blockHash: block.hash,
				parentHash: block.parentHash,
				stateRoot: block.stateRoot,
				extrinsicsRoot: block.extrinsicsRoot,
				author: block.author,
				authorName: block.authorName,
				relayParent: block.relayParent,
				relayNumber: block.relayNumber,
				seenBy: Array.from(block.seenByNodes),
			}).catch(err => console.error(`failed to insert fork block: ${err.message}`));
		}

		await insertForkEvent({
			chain: this.chainName,
			blockNumber: height,
			competingCount: blocks.length,
			authors,
			cause: null, // set later by causation module
			relayHeight: null,
			depth,
		}).catch(err => console.error(`failed to insert fork event: ${err.message}`));
	}

	async onForkUpdated(height, blocksAtHeight) {
		const blocks = Array.from(blocksAtHeight.values());
		const latest = blocks[blocks.length - 1];

		if (latest.author) {
			this.m.author_fork_blocks_total.inc({
				chain: this.chainName,
				author: latest.authorName || latest.author
			});
		}

		await insertForkBlock({
			chain: this.chainName,
			blockNumber: latest.number,
			blockHash: latest.hash,
			parentHash: latest.parentHash,
			author: latest.author,
			authorName: latest.authorName,
			relayParent: latest.relayParent,
			seenBy: Array.from(latest.seenByNodes),
		}).catch(err => console.error(`failed to insert fork block: ${err.message}`));
	}

	/**
	 * called when a height gets finalized.
	 * resolves all recorded forks at or below this height,
	 * since finalization can skip heights.
	 */
	onHeightFinalized(finalizedHeight, finalizedHash) {
		for (const [height] of this.recordedForks) {
			if (height <= finalizedHeight) {
				this.m.active_fork_heights.dec({ chain: this.chainName });
				this.recordedForks.delete(height);

				// mark resolved in ring buffer
				const entry = this.recentForks.findLast(
					f => f.chain === this.chainName && f.block_number === height
				);
				if (entry) {
					entry.resolved = true;
					entry.resolved_hash = finalizedHash;
					entry.resolved_at = new Date().toISOString();
				}
			}
		}
	}

	pruneRecordedForks(belowHeight) {
		for (const [height] of this.recordedForks) {
			if (height <= belowHeight) {
				this.recordedForks.delete(height);
			}
		}
	}
}
