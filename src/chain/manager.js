import { NodeConnection } from './connection.js';
import { BlockTree } from '../monitor/block-tree.js';
import { ForkDetector } from '../monitor/fork-detector.js';
import { FinalityTracker } from '../monitor/finality-tracker.js';
import { AuthorExtractor } from '../monitor/author-extractor.js';
import { ForkCausation } from '../monitor/causation.js';
import { resolveForkEvent } from '../db/queries.js';
import { pruneAfter, timeout } from '../config.js';

const RECONNECT_DELAY = 10000; // 10s between reconnect attempts

export class ChainContext {
	constructor(chainConfig, m) {
		this.name = chainConfig.name;
		this.consensus = chainConfig.consensus || 'unknown';
		this.nodeConfigs = chainConfig.nodes;
		this.knownAuthors = chainConfig.knownAuthors || {};
		this.m = m;

		this.blockTree = new BlockTree(this.name);
		this.forkDetector = new ForkDetector(this.blockTree, m, this.name);
		this.finalityTracker = new FinalityTracker(this.name, m);
		this.authorExtractor = new AuthorExtractor();
		/** @type {NodeConnection[]} */
		this.connections = [];
	}

	/**
	 * resolve author name: knownAuthors config > on-chain identity cache > null.
	 * use resolveAuthorIdentity for async identity fetch.
	 */
	resolveAuthorName(address) {
		if (!address) return null;
		if (this.knownAuthors[address]) return this.knownAuthors[address];
		return this.authorExtractor.identityCache.get(address) || null;
	}

	/**
	 * fetch and cache on-chain identity for an address.
	 * called in the background after block processing.
	 */
	async resolveAuthorIdentity(api, address) {
		if (!address) return null;
		if (this.knownAuthors[address]) return this.knownAuthors[address];
		return this.authorExtractor.resolveIdentity(api, address);
	}

	async connect() {
		await Promise.all(this.nodeConfigs.map(nodeConfig =>
			this.connectNode(nodeConfig)
		));
	}

	async connectNode(nodeConfig) {
		const conn = new NodeConnection(this.name, nodeConfig.name, nodeConfig.url);
		try {
			await conn.connect();
			this.connections.push(conn);
			this.m.node_connected.set({ chain: this.name, node: nodeConfig.name }, 1);
			this.startSubscriptions(conn, nodeConfig);
		} catch (err) {
			console.error(
				`[${this.name}/${nodeConfig.name}] failed to connect: ${err.message}`
			);
			this.m.node_connected.set({ chain: this.name, node: nodeConfig.name }, 0);
			this.scheduleReconnect(nodeConfig);
		}
	}

	scheduleReconnect(nodeConfig) {
		console.log(`[${this.name}/${nodeConfig.name}] will retry in ${RECONNECT_DELAY / 1000}s`);
		setTimeout(() => this.reconnectNode(nodeConfig), RECONNECT_DELAY);
	}

	async reconnectNode(nodeConfig) {
		// remove old connection if any
		const oldIdx = this.connections.findIndex(c => c.nodeName === nodeConfig.name);
		if (oldIdx !== -1) {
			const old = this.connections[oldIdx];
			this.connections.splice(oldIdx, 1);
			await old.disconnect().catch(() => {});
		}

		console.log(`[${this.name}/${nodeConfig.name}] attempting reconnect...`);
		await this.connectNode(nodeConfig);
	}

	startSubscriptions(conn, nodeConfig) {
		const nodeName = nodeConfig.name;
		let watchdogTimer;
		let alive = true;

		const resetWatchdog = () => {
			clearTimeout(watchdogTimer);
			watchdogTimer = setTimeout(() => {
				if (!alive) return;
				alive = false;
				console.error(`[${this.name}/${nodeName}] no block for ${timeout}s, reconnecting`);
				this.m.node_connected.set({ chain: this.name, node: nodeName }, 0);
				this.reconnectNode(nodeConfig);
			}, timeout * 1000);
		};

		resetWatchdog();

		// subscribe to all heads (fork detection)
		conn.api.rpc.chain.subscribeAllHeads(async (header) => {
			resetWatchdog();
			this.m.node_connected.set({ chain: this.name, node: nodeName }, 1);
			const hash = header.hash.toHex();
			const number = header.number.toNumber();
			const parentHash = header.parentHash.toHex();
			const stateRoot = header.stateRoot.toHex();
			const extrinsicsRoot = header.extrinsicsRoot.toHex();

			let author = null;
			try {
				author = await this.authorExtractor.extractAuthor(conn.api, hash);
			} catch (e) {
				// non-critical, continue without author
			}

			// resolve identity (cached after first fetch)
			if (author && !this.authorExtractor.identityCache.has(author)) {
				this.resolveAuthorIdentity(conn.api, author).catch(() => {});
			}

			const authorName = this.resolveAuthorName(author);

			await this.forkDetector.onNewBlock(
				hash, number, parentHash, author, authorName, null, nodeName,
				{ stateRoot, extrinsicsRoot }
			);
		});

		// subscribe to best head (finality lag)
		conn.api.rpc.chain.subscribeNewHeads((header) => {
			resetWatchdog();
			this.m.node_connected.set({ chain: this.name, node: nodeName }, 1);
			this.finalityTracker.onBestHead(nodeName, header.number.toNumber());
		});

		// subscribe to finalized head (pruning + resolution)
		conn.api.rpc.chain.subscribeFinalizedHeads(async (header) => {
			resetWatchdog();
			this.m.node_connected.set({ chain: this.name, node: nodeName }, 1);
			const finalizedNumber = header.number.toNumber();
			const finalizedHash = header.hash.toHex();

			this.finalityTracker.onFinalizedHead(nodeName, finalizedNumber);
			this.blockTree.finalizedHeight = Math.max(
				this.blockTree.finalizedHeight,
				finalizedNumber
			);

			// resolve fork events at finalized heights
			this.forkDetector.onHeightFinalized(finalizedNumber);
			await resolveForkEvent(this.name, finalizedNumber, finalizedHash)
				.catch(() => {}); // ok if no fork event exists at this height

			// prune old data
			const pruneBelow = finalizedNumber - pruneAfter;
			this.blockTree.prune(pruneBelow);
			this.forkDetector.pruneRecordedForks(pruneBelow);
		});

		console.log(`[${this.name}/${nodeName}] subscriptions started`);
	}

	getStatus() {
		return {
			name: this.name,
			consensus: this.consensus,
			bestHeight: this.blockTree.bestHeight,
			finalizedHeight: this.blockTree.finalizedHeight,
			activeForkedHeights: this.blockTree.getForkedHeights(),
			nodes: this.nodeConfigs.map(nc => {
				const conn = this.connections.find(c => c.nodeName === nc.name);
				return {
					name: nc.name,
					url: nc.url,
					connected: conn?.connected || false,
					bestHead: this.finalityTracker.bestHeads.get(nc.name),
					finalizedHead: this.finalityTracker.finalizedHeads.get(nc.name),
				};
			}),
		};
	}
}

export class ChainManager {
	constructor(chainsConfig, m) {
		this.chainsConfig = chainsConfig;
		this.m = m;
		/** @type {Map<string, ChainContext>} */
		this.chains = new Map();
	}

	async start() {
		// create all chain contexts first
		for (const chainConfig of this.chainsConfig) {
			const ctx = new ChainContext(chainConfig, this.m);
			this.chains.set(chainConfig.name, ctx);
		}

		// connect all chains in parallel
		await Promise.all(
			Array.from(this.chains.values()).map(ctx => ctx.connect())
		);

		// set up causation attribution for parachain->relay cross-referencing
		this.setupCausation();
	}

	setupCausation() {
		for (const [name, ctx] of this.chains) {
			const relayChains = Array.from(this.chains.values())
				.filter(c => c.consensus === 'babe' && c.name !== name);

			if (ctx.consensus === 'aura' && relayChains.length > 0) {
				const causation = new ForkCausation(ctx, relayChains[0], this.m);
				ctx.causation = causation;
				console.log(
					`[${name}] causation attribution enabled against relay chain '${relayChains[0].name}'`
				);
			}
		}
	}

	getChain(name) {
		return this.chains.get(name);
	}

	getStatus() {
		const status = {};
		for (const [name, ctx] of this.chains) {
			status[name] = ctx.getStatus();
		}
		return status;
	}
}
