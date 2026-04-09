import { insertForkBlock, insertForkEvent } from '../db/queries.js';

export class ForkDetector {
	constructor(blockTree, m, chainName) {
		this.blockTree = blockTree;
		this.m = m;
		this.chainName = chainName;
		/** @type {Map<number, boolean>} tracks heights where we already recorded a fork event */
		this.recordedForks = new Map();
	}

	/**
	 * called each time a new block header arrives from any node.
	 * detects forks and records metrics + db entries.
	 * @returns {{ record: import('./block-tree.js').BlockRecord, forked: boolean }}
	 */
	async onNewBlock(hash, number, parentHash, author, authorName, relayParent, nodeName) {
		const { record, isNew } = this.blockTree.addBlock(
			hash, number, parentHash, author, authorName, relayParent, nodeName
		);

		if (!isNew) return { record, forked: false };

		this.m.blocks_imported_total.inc({ chain: this.chainName, node: nodeName });

		if (author) {
			this.m.author_blocks_total.inc({
				chain: this.chainName,
				author: authorName || author
			});
		}

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
				author: block.author,
				authorName: block.authorName,
				relayParent: block.relayParent,
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
	onHeightFinalized(finalizedHeight) {
		for (const [height] of this.recordedForks) {
			if (height <= finalizedHeight) {
				this.m.active_fork_heights.dec({ chain: this.chainName });
				this.recordedForks.delete(height);
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
