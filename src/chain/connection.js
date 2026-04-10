import { ApiPromise, WsProvider } from '@polkadot/api';

const CONNECTION_TIMEOUT = 15000; // 15s

/**
 * manages a single websocket connection to a substrate node
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
		/** @type {Function[]} subscription unsub functions */
		this._unsubs = [];
	}

	get tag() {
		return `[${this.chainName}/${this.nodeName}]`;
	}

	async connect() {
		this.provider = new WsProvider(this.url, false);

		this.provider.on('disconnected', () => {
			if (this.connected) {
				console.error(`${this.tag} disconnected from ${this.url}`);
			}
			this.connected = false;
		});

		this.provider.on('connected', () => {
			this.connected = true;
		});

		this.provider.on('error', () => {});

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

	/**
	 * track a subscription so it can be cleaned up on disconnect
	 */
	addUnsub(unsub) {
		this._unsubs.push(unsub);
	}

	async disconnect() {
		// unsubscribe all active subscriptions first
		for (const unsub of this._unsubs) {
			try { await unsub(); } catch (e) {}
		}
		this._unsubs = [];

		if (this.api) {
			try { await this.api.disconnect(); } catch (e) {}
			this.api = null;
		}
		if (this.provider) {
			this.provider.removeAllListeners();
			this.provider = null;
		}
		this.connected = false;
	}
}

function rejectAfter(ms, message) {
	return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}
