/**
 * extracts block author from substrate block headers
 * and resolves on-chain identity for human-readable names.
 * uses polkadot.js api.derive which handles both aura and babe transparently.
 */
export class AuthorExtractor {
	constructor() {
		/** @type {Map<string, string|null>} address -> display name cache */
		this.identityCache = new Map();
	}

	/**
	 * extract the block author from a header hash.
	 * api.derive.chain.getHeader resolves the author from the consensus digest
	 * for both aura (slot-based) and babe (VRF-based) engines.
	 *
	 * @param {import('@polkadot/api').ApiPromise} api
	 * @param {string} headerHash
	 * @returns {Promise<string|null>} author SS58 address or null
	 */
	async extractAuthor(api, headerHash) {
		try {
			const derived = await api.derive.chain.getHeader(headerHash);
			if (derived?.author) {
				return derived.author.toString();
			}
		} catch (e) {
			// some nodes may not support derive, fall through
		}

		// fallback: try manual extraction from digest
		try {
			const header = await api.rpc.chain.getHeader(headerHash);
			return this.extractFromDigest(api, header);
		} catch (e) {
			return null;
		}
	}

	/**
	 * resolve on-chain identity for an address.
	 * checks identity pallet (IdentityOf), falls back to super identity (SuperOf).
	 * results are cached permanently (identities rarely change).
	 *
	 * @param {import('@polkadot/api').ApiPromise} api
	 * @param {string} address
	 * @returns {Promise<string|null>} display name or null
	 */
	async resolveIdentity(api, address) {
		if (!address) return null;

		if (this.identityCache.has(address)) {
			return this.identityCache.get(address);
		}

		let displayName = null;
		try {
			displayName = await this.fetchIdentity(api, address);
		} catch (e) {
			// identity pallet may not exist on this chain
		}

		this.identityCache.set(address, displayName);
		return displayName;
	}

	async fetchIdentity(api, address) {
		// try direct identity first
		if (api.query.identity?.identityOf) {
			const identity = await api.query.identity.identityOf(address);
			if (identity && identity.isSome) {
				const info = identity.unwrap();
				// identityOf returns [Registration, Option<Username>] tuple or just Registration
				const registration = Array.isArray(info) || info.length ? info[0] : info;
				const name = extractDisplayName(registration);
				if (name) return name;
			}
		}

		// try super identity (sub-account of a parent with identity)
		if (api.query.identity?.superOf) {
			const superOf = await api.query.identity.superOf(address);
			if (superOf && superOf.isSome) {
				const [parentAddress, subName] = superOf.unwrap();
				const parentName = await this.resolveIdentity(api, parentAddress.toString());
				const sub = rawToString(subName);
				if (parentName && sub) return `${parentName}/${sub}`;
				if (parentName) return parentName;
			}
		}

		return null;
	}

	/**
	 * manual extraction from aura pre-runtime digest.
	 * for babe, the derive approach is strongly preferred.
	 */
	async extractFromDigest(api, header) {
		const preRuntime = header.digest.logs.find(
			log => log.isPreRuntime && log.asPreRuntime[0].toString() === 'aura'
		);
		if (!preRuntime) return null;

		try {
			const slotData = preRuntime.asPreRuntime[1];
			const slot = api.createType('u64', slotData).toNumber();
			const authorities = await api.query.aura.authorities();
			if (!authorities.length) return null;
			const authorIndex = slot % authorities.length;
			return authorities[authorIndex].toString();
		} catch (e) {
			return null;
		}
	}
}

/**
 * extract display name from an identity Registration struct.
 */
function extractDisplayName(registration) {
	try {
		const info = registration.info || registration;
		const display = info.display;
		return rawToString(display);
	} catch (e) {
		return null;
	}
}

/**
 * convert a substrate Data field (Raw, None, etc.) to a string.
 */
function rawToString(data) {
	if (!data) return null;
	if (data.isRaw) return data.asRaw.toUtf8();
	if (data.isNone) return null;
	// try toString as last resort
	const str = data.toString();
	return str && str !== '' ? str : null;
}
