/**
 * tracks aura slot ownership to detect missed slots.
 * for each new block, compares slot number with parent to find gaps.
 * attributes missed slots to expected collators using: author = authorities[slot % len]
 *
 * only works for aura chains (parachains). babe has probabilistic slot claims.
 */
const MAX_HISTORY = 30;

export class SlotTracker {
	constructor(chainName, m, resolveAuthorName) {
		this.chainName = chainName;
		this.m = m;
		this.resolveAuthorName = resolveAuthorName;
		/** @type {string[]|null} current authorities list */
		this.authorities = null;
		/** @type {number|null} last seen finalized slot */
		this.lastSlot = null;
		/** @type {number} cumulative missed slots */
		this.totalMissed = 0;
		/** @type {number} cumulative produced slots */
		this.totalProduced = 0;
		/** @type {Array<{slot, expected, produced: boolean}>} recent slot history */
		this.recentSlots = [];
		/** @type {number|null} ms-since-epoch when lastSlot was seen */
		this.lastSlotImportedAt = null;
		/** @type {Promise<void>} serialize onFinalizedHeader calls */
		this._queue = Promise.resolve();
		/** @type {number|null} highest block number we've processed for slot tracking */
		this.lastProcessedBlock = null;
	}

	addHistory(entry) {
		this.recentSlots.push(entry);
		if (this.recentSlots.length > MAX_HISTORY) {
			this.recentSlots.shift();
		}
	}

	expectedAuthor(slot) {
		if (!this.authorities || !this.authorities.length) return null;
		const addr = this.authorities[slot % this.authorities.length];
		return this.resolveAuthorName(addr) || addr;
	}

	/**
	 * fetch and cache the aura authorities list.
	 * should be called on startup and after each session change.
	 */
	async refreshAuthorities(api) {
		try {
			// aura.authorities() is the slot-to-author source of truth (session keys)
			const auraList = await api.query.aura.authorities();
			if (!auraList.length) {
				this.authorities = null;
				return;
			}

			// build map: AuraId (session key) -> AccountId via session.nextKeys
			const keyMap = new Map();
			if (api.query.session?.nextKeys) {
				const entries = await api.query.session.nextKeys.entries();
				for (const [storageKey, keysOpt] of entries) {
					const accountId = storageKey.args[0].toString();
					const keys = keysOpt.isSome ? keysOpt.unwrap() : keysOpt;
					// session keys is a struct; try known field names
					const auraKey = keys.aura || keys.Aura || keys.nimbus || keys;
					if (auraKey) {
						keyMap.set(auraKey.toString(), accountId);
					}
				}
			}

			const unmapped = [];
			this.authorities = auraList.map(a => {
				const auraKey = a.toString();
				const acct = keyMap.get(auraKey);
				if (!acct) unmapped.push(auraKey);
				return acct || auraKey;
			});

			if (unmapped.length > 0) {
				console.log(`[${this.chainName}] slot tracker: ${unmapped.length}/${auraList.length} authorities unmapped (using session key as fallback)`);
			}
		} catch (e) {
			this.authorities = null;
		}
	}

	/**
	 * extract the aura slot number from a header's pre-runtime digest.
	 * the digest payload is a SCALE-encoded Slot (u64 LE, 8 bytes).
	 * @returns {number|null}
	 */
	extractSlot(header) {
		try {
			const preRuntime = header.digest.logs.find(
				log => log.isPreRuntime && log.asPreRuntime[0].toString() === 'aura'
			);
			if (!preRuntime) return null;
			const slotData = preRuntime.asPreRuntime[1];
			// toU8a(true) strips the length prefix, leaving only the slot bytes
			const buf = slotData.toU8a(true);
			if (buf.length < 8) return null;
			let slot = 0n;
			for (let i = 0; i < 8; i++) {
				slot |= BigInt(buf[i]) << BigInt(i * 8);
			}
			return Number(slot);
		} catch (e) {
			return null;
		}
	}

	/**
	 * called on each finalized head. detects missed slots between this block
	 * and the previous finalized block.
	 */
	/**
	 * process a single finalized block's slot.
	 * use processRange() when finalization jumps multiple blocks.
	 */
	processSlot(slot, blockNumber = null) {
		// guard: skip out-of-order or duplicate slots
		if (this.lastSlot !== null && slot <= this.lastSlot) return;

		if (this.lastSlot !== null && slot > this.lastSlot + 1) {
			// genuine gap -- attribute each missed slot to its expected author
			for (let s = this.lastSlot + 1; s < slot; s++) {
				const expected = this.expectedAuthor(s);
				if (expected) {
					this.m.collator_missed_slots_total.inc({
						chain: this.chainName,
						collator: expected,
					});
				}
				this.addHistory({ slot: s, expected, produced: false, block: null });
			}
			this.totalMissed += slot - this.lastSlot - 1;
		}

		const expected = this.expectedAuthor(slot);
		if (expected) {
			this.m.collator_produced_slots_total.inc({
				chain: this.chainName,
				collator: expected,
			});
		}
		this.addHistory({ slot, expected, produced: true, block: blockNumber });
		this.totalProduced++;

		this.lastSlot = slot;
		this.lastSlotImportedAt = Date.now();
	}

	/**
	 * called on each finalized head. if finalization jumped, fetch intermediate
	 * block headers so we don't count their slots as missed.
	 */
	onFinalizedHeader(api, header, lastFinalizedNumber) {
		// serialize to prevent interleaved processing
		this._queue = this._queue.then(() =>
			this._processFinalizedHeader(api, header, lastFinalizedNumber).catch(() => {})
		);
		return this._queue;
	}

	async _processFinalizedHeader(api, header, lastFinalizedNumber) {
		const currentNumber = header.number.toNumber();

		if (this.lastProcessedBlock !== null && this.lastProcessedBlock !== undefined
			&& currentNumber <= this.lastProcessedBlock) {
			return;
		}

		const startFrom = this.lastProcessedBlock !== null && this.lastProcessedBlock !== undefined
			? this.lastProcessedBlock
			: lastFinalizedNumber;

		if (startFrom !== null && currentNumber > startFrom + 1) {
			const start = Math.max(startFrom + 1, currentNumber - 50);
			for (let n = start; n < currentNumber; n++) {
				try {
					const hash = await api.rpc.chain.getBlockHash(n);
					const h = await api.rpc.chain.getHeader(hash);
					const slot = this.extractSlot(h);
					if (slot !== null) await this.processSlotWithActual(api, slot, n, hash);
				} catch (e) { /* skip */ }
			}
		}

		const slot = this.extractSlot(header);
		if (slot !== null) await this.processSlotWithActual(api, slot, currentNumber, header.hash.toHex());
		this.lastProcessedBlock = currentNumber;
	}

	/**
	 * process a slot using the ACTUAL block author from derived header.
	 * this corrects for cases where our authorities[slot % N] mapping is wrong.
	 */
	async processSlotWithActual(api, slot, blockNumber, blockHash) {
		// guard: skip duplicates/out-of-order
		if (this.lastSlot !== null && slot <= this.lastSlot) return;

		// attribute missed slots to expected (best effort from mapping)
		if (this.lastSlot !== null && slot > this.lastSlot + 1) {
			for (let s = this.lastSlot + 1; s < slot; s++) {
				const expected = this.expectedAuthor(s);
				if (expected) {
					this.m.collator_missed_slots_total.inc({
						chain: this.chainName,
						collator: expected,
					});
				}
				this.addHistory({ slot: s, expected, produced: false, block: null });
			}
			this.totalMissed += slot - this.lastSlot - 1;
		}

		// use actual author for produced slot
		let actual = null;
		try {
			const derived = await api.derive.chain.getHeader(blockHash);
			if (derived?.author) actual = derived.author.toString();
		} catch (e) {}

		const displayName = this.resolveAuthorName(actual) || actual || this.expectedAuthor(slot);
		if (actual) {
			this.m.collator_produced_slots_total.inc({
				chain: this.chainName,
				collator: this.resolveAuthorName(actual) || actual,
			});
		}
		this.addHistory({ slot, expected: displayName, produced: true, block: blockNumber });
		this.totalProduced++;

		this.lastSlot = slot;
		this.lastSlotImportedAt = Date.now();
	}
}
