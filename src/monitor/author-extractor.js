/**
 * extracts block author from substrate block headers.
 * uses polkadot.js api.derive which handles both aura and babe transparently.
 */
export class AuthorExtractor {
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
