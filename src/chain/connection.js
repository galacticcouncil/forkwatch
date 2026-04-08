import { ApiPromise, WsProvider } from '@polkadot/api';

const CONNECTION_TIMEOUT = 15000; // 15s

/**
 * manages a single websocket connection to a substrate node
 * with automatic reconnection
 */
export class NodeConnection {
	constructor(chainName, nodeName, url) {
		this.chainName = chainName;
		this.nodeName = nodeName;
		this.url = url;
		/** @type {ApiPromise|null} */
		this.api = null;
		/** @type {WsProvider|null} */
		this.provider = null;
		this.connected = false;
		this._onReconnect = null;
	}

	get tag() {
		return `[${this.chainName}/${this.nodeName}]`;
	}

	/**
	 * register a callback that fires when connection is (re)established.
	 * used by manager to re-subscribe after reconnect.
	 */
	onReconnect(fn) {
		this._onReconnect = fn;
	}

	async connect() {
		// WsProvider with autoConnect handles reconnection internally
		this.provider = new WsProvider(this.url, false);

		this.provider.on('disconnected', () => {
			if (this.connected) {
				console.error(`${this.tag} disconnected from ${this.url}`);
			}
			this.connected = false;
		});

		this.provider.on('connected', () => {
			const wasDisconnected = !this.connected;
			this.connected = true;
			if (wasDisconnected && this.api) {
				console.log(`${this.tag} reconnected to ${this.url}`);
			}
		});

		this.provider.on('error', () => {
			// suppress, WsProvider retries automatically
		});

		// initial connect with timeout
		await Promise.race([
			this.provider.connect(),
			rejectAfter(CONNECTION_TIMEOUT, 'connection timeout'),
		]);

		this.api = await Promise.race([
			ApiPromise.create({ provider: this.provider }),
			rejectAfter(CONNECTION_TIMEOUT, 'api creation timeout'),
		]);

		this.connected = true;

		const version = await this.api.rpc.system.version();
		const chain = await this.api.rpc.system.chain();
		console.log(`${this.tag} connected to ${chain} v${version} on ${this.url}`);

		return this.api;
	}

	async disconnect() {
		if (this.api) {
			await this.api.disconnect();
			this.api = null;
			this.provider = null;
			this.connected = false;
		}
	}
}

function rejectAfter(ms, message) {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
