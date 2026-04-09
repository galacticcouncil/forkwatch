/**
 * @typedef {Object} BlockRecord
 * @property {string} hash
 * @property {number} number
 * @property {string} parentHash
 * @property {string|null} author
 * @property {string|null} authorName
 * @property {string|null} stateRoot
 * @property {string|null} extrinsicsRoot
 * @property {string|null} relayParent
 * @property {number|null} relayNumber
 * @property {number} importedAt
 * @property {Set<string>} seenByNodes
 */

export class BlockTree {
	constructor(chainName) {
		this.chainName = chainName;
		/** @type {Map<number, Map<string, BlockRecord>>} */
		this.blocksByHeight = new Map();
		/** @type {Map<string, BlockRecord>} */
		this.blocksByHash = new Map();
		this.finalizedHeight = 0;
		this.bestHeight = 0;
	}

	/**
	 * add a block to the tree. returns the record and whether it's new.
	 * @returns {{ record: BlockRecord, isNew: boolean }}
	 */
	addBlock(hash, number, parentHash, author, authorName, relayParent, nodeName, extra = {}) {
		const existing = this.blocksByHash.get(hash);
		if (existing) {
			existing.seenByNodes.add(nodeName);
			return { record: existing, isNew: false };
		}

		const record = {
			hash,
			number,
			parentHash,
			author,
			authorName,
			stateRoot: extra.stateRoot || null,
			extrinsicsRoot: extra.extrinsicsRoot || null,
			relayParent,
			relayNumber: extra.relayNumber || null,
			importedAt: Date.now(),
			seenByNodes: new Set([nodeName]),
		};

		if (!this.blocksByHeight.has(number)) {
			this.blocksByHeight.set(number, new Map());
		}
		this.blocksByHeight.get(number).set(hash, record);
		this.blocksByHash.set(hash, record);

		if (number > this.bestHeight) {
			this.bestHeight = number;
		}

		return { record, isNew: true };
	}

	getBlocksAtHeight(height) {
		return this.blocksByHeight.get(height);
	}

	getBlock(hash) {
		return this.blocksByHash.get(hash);
	}

	/**
	 * returns heights that have more than one distinct block hash
	 */
	getForkedHeights() {
		const forked = [];
		for (const [height, blocks] of this.blocksByHeight) {
			if (blocks.size > 1) {
				forked.push(height);
			}
		}
		return forked.sort((a, b) => a - b);
	}

	/**
	 * measure consecutive forked heights starting from the given height, walking backwards
	 */
	measureForkDepth(forkHeight) {
		let depth = 1;
		let h = forkHeight - 1;
		while (this.blocksByHeight.get(h)?.size > 1) {
			depth++;
			h--;
		}
		return depth;
	}

	prune(keepAboveHeight) {
		for (const [height, blocks] of this.blocksByHeight) {
			if (height <= keepAboveHeight) {
				for (const [hash] of blocks) {
					this.blocksByHash.delete(hash);
				}
				this.blocksByHeight.delete(height);
			}
		}
	}
}
