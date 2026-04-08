import { insertFinalityLog } from '../db/queries.js';
import { finalityLogInterval } from '../config.js';

export class FinalityTracker {
	constructor(chainName, m) {
		this.chainName = chainName;
		this.m = m;
		/** @type {Map<string, number>} nodeName -> best block number */
		this.bestHeads = new Map();
		/** @type {Map<string, number>} nodeName -> finalized block number */
		this.finalizedHeads = new Map();
		/** @type {Map<string, number>} nodeName -> last log timestamp */
		this.lastLogTime = new Map();
	}

	onBestHead(nodeName, blockNumber) {
		this.bestHeads.set(nodeName, blockNumber);
		this.m.best_block_height.set(
			{ chain: this.chainName, node: nodeName },
			blockNumber
		);
		this.updateLag(nodeName);
	}

	onFinalizedHead(nodeName, blockNumber) {
		this.finalizedHeads.set(nodeName, blockNumber);
		this.m.finalized_block_height.set(
			{ chain: this.chainName, node: nodeName },
			blockNumber
		);
		this.updateLag(nodeName);
		this.maybeSampleFinalityLog(nodeName);
	}

	updateLag(nodeName) {
		const best = this.bestHeads.get(nodeName);
		const finalized = this.finalizedHeads.get(nodeName);
		if (best !== undefined && finalized !== undefined) {
			const lag = best - finalized;
			this.m.finality_lag_blocks.set(
				{ chain: this.chainName, node: nodeName },
				lag
			);
		}
	}

	async maybeSampleFinalityLog(nodeName) {
		const now = Date.now();
		const lastLog = this.lastLogTime.get(nodeName) || 0;
		if (now - lastLog < finalityLogInterval * 1000) return;

		this.lastLogTime.set(nodeName, now);

		const best = this.bestHeads.get(nodeName);
		const finalized = this.finalizedHeads.get(nodeName);
		if (best === undefined || finalized === undefined) return;

		await insertFinalityLog({
			chain: this.chainName,
			node: nodeName,
			bestHeight: best,
			finalizedHeight: finalized,
			lag: best - finalized,
		}).catch(err => console.error(`failed to log finality: ${err.message}`));
	}
}
