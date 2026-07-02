import { extractTrackedExtrinsics } from './extrinsic-utils.js';
import { insertSubmittedTx, insertResubmitAttempt } from '../db/queries.js';

const DROP_GRACE_POLLS = 3; // polls to wait before treating a vanished tx as a drop candidate
const DROP_MAX_WAIT_POLLS = 20; // polls to wait for a late resubmission before finalizing dropped/expired
const MAX_FINALIZED_HASHES = 10000; // safety cap on the double-finalize guard set
const UNSUPPORTED_RECHECK_MS = 30 * 60 * 1000; // retry nodes marked unsupported periodically
const RESUBMIT_RETRY_INTERVAL_MS = 30000; // fixed cadence for auto-resubmit retries, independent of blocktime
const MAX_RESUBMIT_RETRIES = 30; // safety cap (~15 minutes at the 30s interval)
const REAPPEAR_DEBOUNCE_POLLS = 2; // consecutive present-polls required before treating a missing candidate as recovered

const METRIC_BY_STATUS = {
	dropped: 'tx_dropped_total',
	expired: 'tx_expired_total',
	resubmitted: 'tx_resubmitted_total',
	reorged_lost: 'tx_reorged_lost_total',
	reorged_resubmitted: 'tx_reorged_resubmitted_total',
};

/**
 * tracks submitted transactions across two independent event sources feeding
 * one per-(signer,nonce) state machine:
 *  - mempool poll diff: a tx seen pending, then vanished
 *  - block-body extraction + fork resolution: a tx included in a since-orphaned block
 *
 * "canonical" inclusion (used for resubmission-linking) is only recorded once
 * a block is confirmed via the finalized-heads walk -- inclusion observed at
 * import time (onNewBlock, which also sees losing fork-branch blocks) is kept
 * separately and only used for the coarse "was this hash included anywhere"
 * check, so a losing block's own extrinsics can't look like their own resubmission.
 */
export class TxTracker {
	constructor(chainName, m, opts = {}) {
		this.chainName = chainName;
		this.m = m;
		this.pollIntervalMs = opts.pollIntervalMs || 6000;
		this.reorgGracePeriodBlocks = opts.reorgGracePeriodBlocks ?? 10;
		this.dropGracePolls = opts.dropGracePolls ?? DROP_GRACE_POLLS;
		this.dropMaxWaitPolls = opts.dropMaxWaitPolls ?? DROP_MAX_WAIT_POLLS;
		this.reappearDebouncePolls = opts.reappearDebouncePolls ?? REAPPEAR_DEBOUNCE_POLLS;

		/**
		 * auto-resubmission replays the exact already-signed bytes for every
		 * tracked transaction -- no signing ever happens, only replays what we
		 * captured globally. gated by resubmitEnabled; captures raw from every tx.
		 */
		this.resubmitEnabled = !!opts.resubmitEnabled;
		this.resubmitRetryIntervalMs = opts.resubmitRetryIntervalMs ?? RESUBMIT_RETRY_INTERVAL_MS;
		this.maxResubmitRetries = opts.maxResubmitRetries ?? MAX_RESUBMIT_RETRIES;
		/** @type {Map<string, {timer: object, lostAtHeight: number|null}>} active periodic retry loops, keyed by hash -- doubles as the idempotency guard (a hash already in here won't be started twice) */
		this.resubmitRetryTimers = new Map();
		/** @type {(() => Array)|null} returns current NodeConnections for the chain, set by start() -- resubmissions fan out to every connected one, since any single node may already have (or be missing) a given hash */
		this.getConnections = null;

		/** @type {Map<string, {number:number, extrinsics: Array}>} keyed by block hash */
		this.blockExtrinsics = new Map();
		/** @type {Set<number>} forked heights already queued for reorg review */
		this.processedForkHeights = new Set();
		/** @type {number|null} highest finalized height the canonical walk has covered */
		this.lastCanonicalWalkHeight = null;
		/** @type {number} highest block height observed, used to anchor era decoding and expiry checks */
		this.lastKnownHeight = 0;

		/** @type {Map<string, object>} latest CONFIRMED-CANONICAL inclusion per "signer:nonce" */
		this.latestBySignerNonce = new Map();
		/** @type {Set<string>} tx hashes seen included in any imported block (canonical or not) */
		this.includedHashes = new Set();

		/** @type {Map<string, object>} previous mempool poll snapshot, keyed by hash */
		this.pendingPool = new Map();
		/** @type {Map<string, object>} hashes that vanished from the pool, awaiting resolution */
		this.missingCandidates = new Map();
		/** @type {Array<object>} losing-branch extrinsics awaiting their reorg grace window */
		this.pendingReorgReview = [];

		/** @type {Set<string>} guards against finalizing (persisting/counting) the same hash twice */
		this.finalizedHashes = new Set();

		/** @type {Set<string>} node names that rejected author_pendingExtrinsics, probed at runtime */
		this.unsupportedNodes = new Set();
		this.lastUnsupportedResetAt = null;

		this.pollTimer = null;
		this.warnedNoUnsafeRpc = false;
	}

	key(signer, nonce) {
		return `${signer}:${nonce}`;
	}

	/**
	 * called once per unique new block (isNew from ForkDetector.onNewBlock),
	 * from whichever node reported it first -- including losing fork-branch blocks,
	 * which is required for reorg-loss detection to see what they contained.
	 */
	async onNewBlock(api, hash, number) {
		this.lastKnownHeight = Math.max(this.lastKnownHeight, number);

		let extrinsics;
		try {
			// raw rpc.chain.getBlock (not api.derive.*) -- rpc-core's memo() unmemoizes
			// its cache entry as soon as this awaited call resolves, so this does not
			// reproduce the api-derive per-block cache leak documented in manager.js.
			const signedBlock = await api.rpc.chain.getBlock(hash);
			extrinsics = extractTrackedExtrinsics(signedBlock.block.extrinsics, number);
		} catch (e) {
			return;
		}

		this.blockExtrinsics.set(hash, { number, extrinsics });
		if (extrinsics.length) {
			this.m.tx_tracked_total?.inc({ chain: this.chainName }, extrinsics.length);
		}

		for (const tx of extrinsics) {
			this.includedHashes.add(tx.hash);
		}
	}

	/**
	 * mark a confirmed-canonical block's extrinsics as the latest known
	 * inclusion for their (signer, nonce). only called from the finalized-heads
	 * walk, never at import time, so losing branches can't pollute this map.
	 */
	markCanonical(blockHash, blockNumber) {
		const captured = this.blockExtrinsics.get(blockHash);
		if (!captured) return;

		for (const tx of captured.extrinsics) {
			if (tx.signer === null || tx.nonce === null) continue;
			this.latestBySignerNonce.set(this.key(tx.signer, tx.nonce), {
				hash: tx.hash,
				blockHash,
				blockNumber,
				section: tx.section,
				method: tx.method,
				era: tx.era,
			});
		}
	}

	/**
	 * poll a node's pending pool, diff against the previous snapshot, and feed
	 * vanished hashes into the shared state machine. author_pendingExtrinsics is
	 * an unsafe RPC that many public nodes reject -- rather than requiring
	 * per-node config, this probes at runtime: a node that rejects the call is
	 * remembered as unsupported (see pickPollableConnection) and not retried
	 * until the periodic recheck window passes.
	 */
	async pollPendingPool(conn) {
		let raw;
		try {
			raw = await conn.api.rpc.author.pendingExtrinsics();
		} catch (e) {
			this.unsupportedNodes.add(conn.nodeName);
			return;
		}

		const extracted = extractTrackedExtrinsics(raw, this.lastKnownHeight);
		const currentByHash = new Map(extracted.map(tx => [tx.hash, tx]));

		for (const [hash, prevTx] of this.pendingPool) {
			if (!currentByHash.has(hash)) {
				this.onTxLeftPool(hash, prevTx);
			}
		}

		for (const [hash, tx] of currentByHash) {
			const cand = this.missingCandidates.get(hash);
			if (cand) {
				// debounce: require REAPPEAR_DEBOUNCE_POLLS consecutive present-polls
				// before fully clearing it. a single-poll flicker (this node's view
				// briefly catching up, not a real recovery) would otherwise tear down
				// and immediately restart the retry loop, firing a fresh "immediate
				// first attempt" every time -- which looks like a much faster retry
				// cadence than RESUBMIT_RETRY_INTERVAL_MS actually is.
				cand.reappearedStreak = (cand.reappearedStreak || 0) + 1;
				if (cand.reappearedStreak >= this.reappearDebouncePolls) {
					this.missingCandidates.delete(hash);
					this.stopResubmitRetry(hash);
				}
			}
			if (!this.pendingPool.has(hash)) {
				this.pendingPool.set(hash, { ...tx, firstSeenAt: Date.now() });
			}
		}

		for (const hash of this.pendingPool.keys()) {
			if (!currentByHash.has(hash)) this.pendingPool.delete(hash);
		}

		this.reviewMissingCandidates();
	}

	onTxLeftPool(hash, tx) {
		if (this.includedHashes.has(hash)) return; // clean success, nothing to track

		const existing = this.missingCandidates.get(hash);
		if (existing) {
			existing.reappearedStreak = 0; // flickered again -- cancel the pending "recovered" call, keep its missingSincePollCount clock running
			return;
		}
		this.missingCandidates.set(hash, { ...tx, missingSincePollCount: 0, reappearedStreak: 0 });
	}

	reviewMissingCandidates() {
		for (const [hash, cand] of this.missingCandidates) {
			if (this.includedHashes.has(hash)) {
				this.missingCandidates.delete(hash);
				continue;
			}

			cand.missingSincePollCount++;
			if (cand.missingSincePollCount < this.dropGracePolls) continue;

			// past the noise threshold -- start trying to get it back in ourselves
			// (all tracked accounts; no-ops when raw is missing). classification below
			// still runs on its own schedule regardless of whether this succeeds.
			this.startResubmitRetry(cand);

			const resubmission = this.findResubmission(cand, hash);
			if (resubmission) {
				this.finalize(cand, hash, 'resubmitted', {
					replacedBy: resubmission.hash,
					resolvedHeight: resubmission.blockNumber,
				});
				this.missingCandidates.delete(hash);
				continue;
			}

			if (cand.missingSincePollCount < this.dropMaxWaitPolls) continue;

			const status = this.isExpired(cand) ? 'expired' : 'dropped';
			this.finalize(cand, hash, status, {});
			this.missingCandidates.delete(hash);
		}
	}

	/**
	 * has the canonical chain since included a DIFFERENT hash for this (signer,nonce)?
	 */
	findResubmission(record, originalHash) {
		if (record.signer === null || record.nonce === null) return null;
		const latest = this.latestBySignerNonce.get(this.key(record.signer, record.nonce));
		if (latest && latest.hash !== originalHash) return latest;
		return null;
	}

	isExpired(record) {
		if (!record.era) return false; // immortal, or evm (no era concept)
		return this.lastKnownHeight >= record.era.death;
	}

	/**
	 * called from manager.js after ForkDetector.onHeightFinalized and before
	 * blockTree.prune -- walks the newly-finalized canonical range, queues
	 * losing-branch extrinsics from any newly-resolved forked heights for
	 * reorg-loss review, and resolves entries whose grace window has elapsed.
	 */
	onHeightFinalized(finalizedHeight, finalizedHash, blockTree) {
		this.lastKnownHeight = Math.max(this.lastKnownHeight, finalizedHeight);

		const walkFloor = this.lastCanonicalWalkHeight ?? finalizedHeight - 1;
		let cursor = blockTree.getBlock(finalizedHash);
		while (cursor && cursor.number > walkFloor) {
			this.markCanonical(cursor.hash, cursor.number);
			cursor = blockTree.getBlock(cursor.parentHash);
		}
		this.lastCanonicalWalkHeight = Math.max(this.lastCanonicalWalkHeight ?? 0, finalizedHeight);

		for (const height of blockTree.getForkedHeights()) {
			if (height > finalizedHeight || this.processedForkHeights.has(height)) continue;
			this.processedForkHeights.add(height);
			this.queueReorgReview(height, finalizedHash, blockTree);
		}

		const stillPending = [];
		for (const entry of this.pendingReorgReview) {
			if (finalizedHeight < entry.dueAtHeight) {
				stillPending.push(entry);
				continue;
			}
			this.resolveReorgEntry(entry);
		}
		this.pendingReorgReview = stillPending;
	}

	queueReorgReview(height, finalizedHash, blockTree) {
		const canonical = blockTree.getCanonicalAncestorAt(finalizedHash, height);
		const blocksAtHeight = blockTree.getBlocksAtHeight(height);
		if (!blocksAtHeight) return;

		for (const [hash] of blocksAtHeight) {
			if (canonical && hash === canonical.hash) continue; // this one won, nothing lost here

			const losing = this.blockExtrinsics.get(hash);
			if (!losing) continue; // never captured its body (fetch failed/raced)

			for (const tx of losing.extrinsics) {
				const entry = {
					...tx,
					lostAtHeight: height,
					lostAtHash: hash,
					dueAtHeight: height + this.reorgGracePeriodBlocks,
				};
				this.pendingReorgReview.push(entry);
				// the loss is already settled (this runs from onHeightFinalized, so
				// state is final) -- no reason to wait out the grace period before
				// trying to get it back in. classification (reorged_lost/resubmitted)
				// still happens on its own schedule via resolveReorgEntry below.
				this.startResubmitRetry(entry);
			}
		}
	}

	resolveReorgEntry(entry) {
		const resubmission = this.findResubmission(entry, entry.hash);
		if (resubmission) {
			this.finalize(entry, entry.hash, 'reorged_resubmitted', {
				replacedBy: resubmission.hash,
				lostAtHeight: entry.lostAtHeight,
				lostAtHash: entry.lostAtHash,
				resolvedHeight: resubmission.blockNumber,
			});
			return;
		}

		const key = entry.signer !== null && entry.nonce !== null ? this.key(entry.signer, entry.nonce) : null;
		const latest = key ? this.latestBySignerNonce.get(key) : null;
		if (latest && latest.hash === entry.hash) return; // reincluded unchanged, not worth alerting

		const status = this.isExpired(entry) ? 'expired' : 'reorged_lost';
		this.finalize(entry, entry.hash, status, {
			lostAtHeight: entry.lostAtHeight,
			lostAtHash: entry.lostAtHash,
		});
	}

	toAttempt(record, hash, outcome) {
		return {
			hash,
			birth: record.era?.birth ?? null,
			death: record.era?.death ?? null,
			firstSeenAt: record.firstSeenAt ?? null,
			outcome,
		};
	}

	finalize(record, originalHash, status, extra = {}) {
		if (this.finalizedHashes.has(originalHash)) return;
		if (this.finalizedHashes.size >= MAX_FINALIZED_HASHES) this.finalizedHashes.clear();
		this.finalizedHashes.add(originalHash);

		const originalOutcome = status.startsWith('reorged') ? 'orphaned_by_reorg'
			: (status === 'resubmitted' ? 'vanished_from_pool' : status);
		const attempts = [this.toAttempt(record, originalHash, originalOutcome)];

		if (extra.replacedBy) {
			const key = record.signer !== null && record.nonce !== null ? this.key(record.signer, record.nonce) : null;
			const replaced = key ? this.latestBySignerNonce.get(key) : null;
			if (replaced) attempts.push(this.toAttempt({ era: replaced.era }, replaced.hash, 'included'));
		}

		const metricKey = METRIC_BY_STATUS[status];
		if (metricKey) this.m[metricKey]?.inc({ chain: this.chainName });

		insertSubmittedTx({
			chain: this.chainName,
			signer: record.signer,
			nonce: record.nonce,
			kind: record.kind,
			section: record.section,
			method: record.method,
			status,
			firstHash: originalHash,
			lastHash: extra.replacedBy || originalHash,
			attempts,
			lostAtHeight: extra.lostAtHeight ?? null,
			lostAtHash: extra.lostAtHash ?? null,
			resolvedHash: extra.replacedBy ?? null,
			resolvedHeight: extra.resolvedHeight ?? null,
		}).catch(err => console.error(`[${this.chainName}] failed to insert submitted_tx: ${err.message}`));
	}

	/**
	 * replay the exact already-signed bytes we captured for any tracked
	 * account -- no new signature is ever created here, ever. fans out to
	 * EVERY currently-connected node for the chain, not just one: a node that
	 * already has (or recently had) this exact hash will reject it as
	 * "already imported" even though the transaction is genuinely missing
	 * from the network's canonical view, so a single-node attempt tells us
	 * little. counts as succeeded if any node accepts it. records one
	 * aggregate row per attempt to resubmit_attempts regardless of whether
	 * the underlying incident ever gets a submitted_txs row.
	 */
	async resubmitOnce(record, hash, trigger) {
		const connections = (this.getConnections?.() || []).filter(c => c.connected);
		this.m.tx_resubmit_attempted_total?.inc({ chain: this.chainName });

		if (!connections.length) {
			this.m.tx_resubmit_failed_total?.inc({ chain: this.chainName });
			insertResubmitAttempt({
				chain: this.chainName, signer: record.signer, nonce: record.nonce,
				hash, trigger, result: 'failed', error: 'no connected nodes',
			}).catch(err => console.error(`[${this.chainName}] failed to insert resubmit_attempt: ${err.message}`));
			return;
		}

		const results = await Promise.allSettled(
			connections.map(c => c.api.rpc.author.submitExtrinsic(record.raw).then(r => ({ node: c.nodeName, hash: r })))
		);
		const accepted = results.filter(r => r.status === 'fulfilled');
		const rejected = results.filter(r => r.status === 'rejected');

		if (accepted.length) {
			this.m.tx_resubmit_succeeded_total?.inc({ chain: this.chainName });
			console.log(`[${this.chainName}] auto-resubmitted ${hash} for signer ${record.signer} (${trigger}) -- accepted by ${accepted.length}/${connections.length} nodes (${accepted.map(r => r.value.node).join(', ')})`);
			insertResubmitAttempt({
				chain: this.chainName, signer: record.signer, nonce: record.nonce,
				hash, trigger, result: 'succeeded', error: null,
			}).catch(err => console.error(`[${this.chainName}] failed to insert resubmit_attempt: ${err.message}`));
		} else {
			const summary = [...new Set(rejected.map(r => r.reason?.message || String(r.reason)))].join('; ');
			console.log(`[${this.chainName}] auto-resubmit failed for ${hash} (signer ${record.signer}, ${trigger}) -- rejected by all ${connections.length} nodes: ${summary}`);
			this.m.tx_resubmit_failed_total?.inc({ chain: this.chainName });
			insertResubmitAttempt({
				chain: this.chainName, signer: record.signer, nonce: record.nonce,
				hash, trigger, result: 'failed', error: `0/${connections.length} nodes accepted: ${summary}`,
			}).catch(err => console.error(`[${this.chainName}] failed to insert resubmit_attempt: ${err.message}`));
		}
	}

	/**
	 * start (or no-op if already running) a periodic resubmission loop for every
	 * queueReorgReview -- fires immediately, since by that point the loss is
	 * already settled via onHeightFinalized; or a mempool drop candidate, via
	 * reviewMissingCandidates -- fires once past the noise threshold). fires
	 * an immediate first attempt, then retries every RESUBMIT_RETRY_INTERVAL_MS
	 * until one of:
	 *  - included: the exact same hash showed up in a block (we never re-sign,
	 *    so success always means this original hash, not a new one)
	 *  - nonce invalid: a different hash resolved this (signer,nonce) -- our
	 *    stale bytes can no longer land, further retries are pointless
	 *  - era invalid: the mortal era's death block has passed -- same reasoning
	 *  - safety cap: MAX_RESUBMIT_RETRIES reached, in case none of the above
	 *    ever resolves (e.g. permanently invalid for an unrelated reason)
	 */
	startResubmitRetry(record) {
		if (!this.resubmitEnabled) return;
		if (!record.raw || !record.signer) return;
		if (this.resubmitRetryTimers.has(record.hash)) return; // already retrying this exact hash

		let attempts = 0;
		const tick = () => {
			// canonical inclusion only -- record.raw is only ever captured once
			// signer+nonce are both known (see extrinsic-utils.js), so this lookup
			// is always valid here. includedHashes can't be used for "succeeded":
			// a reorg-retry's hash is *already* in there from the losing block it
			// came from, which would look like an instant false-positive success.
			const latest = this.latestBySignerNonce.get(this.key(record.signer, record.nonce));
			if (latest && latest.hash === record.hash) {
				this.stopResubmitRetry(record.hash); // succeeded -- now canonical
				return;
			}
			if (latest && latest.hash !== record.hash) {
				this.stopResubmitRetry(record.hash); // nonce consumed by a different hash
				return;
			}
			if (this.isExpired(record)) {
				this.stopResubmitRetry(record.hash); // era lapsed
				return;
			}
			if (attempts >= this.maxResubmitRetries) {
				this.stopResubmitRetry(record.hash);
				return;
			}
			if (!this.getConnections?.().some(c => c.connected)) return; // no connection yet -- try again next tick

			attempts++;
			this.resubmitOnce(record, record.hash, record.lostAtHeight != null ? 'reorg_loss' : 'mempool_drop');
		};

		tick(); // immediate first attempt, no reason to wait
		const timer = setInterval(tick, this.resubmitRetryIntervalMs);
		this.resubmitRetryTimers.set(record.hash, { timer, lostAtHeight: record.lostAtHeight ?? null });
	}

	stopResubmitRetry(hash) {
		const entry = this.resubmitRetryTimers.get(hash);
		if (entry) {
			clearInterval(entry.timer);
			this.resubmitRetryTimers.delete(hash);
		}
	}

	/**
	 * prune in lockstep with blockTree.prune -- anything below this height is
	 * unreachable by the reorg-resolution walk anyway.
	 */
	pruneBlocks(belowHeight) {
		for (const [hash, entry] of this.blockExtrinsics) {
			if (entry.number <= belowHeight) this.blockExtrinsics.delete(hash);
		}
		for (const height of this.processedForkHeights) {
			if (height <= belowHeight) this.processedForkHeights.delete(height);
		}
		// safety net: a retry loop should always self-stop via its own conditions,
		// but if a connection never comes back this guarantees it doesn't run forever
		for (const [hash, entry] of this.resubmitRetryTimers) {
			if (entry.lostAtHeight <= belowHeight) this.stopResubmitRetry(hash);
		}
	}

	/**
	 * pick a connected node not already known to reject author_pendingExtrinsics.
	 * periodically forgets past rejections so a node that starts supporting it
	 * (config change, upgrade) or failed only transiently gets retried.
	 */
	pickPollableConnection(connections) {
		const now = Date.now();
		if (this.lastUnsupportedResetAt === null) {
			this.lastUnsupportedResetAt = now;
		} else if (now - this.lastUnsupportedResetAt > UNSUPPORTED_RECHECK_MS) {
			this.unsupportedNodes.clear();
			this.lastUnsupportedResetAt = now;
		}

		return connections.find(c => c.connected && !this.unsupportedNodes.has(c.nodeName)) || null;
	}

	/**
	 * start mempool polling. getConnections should return all NodeConnections
	 * for the chain (connected or not) -- capability is probed at runtime, not
	 * configured, since public RPC endpoints typically reject this unsafe call.
	 * also stashed for resubmission fan-out (see resubmitOnce).
	 */
	start(getConnections) {
		this.getConnections = getConnections;
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => {
			const conn = this.pickPollableConnection(getConnections());
			if (!conn) {
				if (!this.warnedNoUnsafeRpc) {
					console.log(`[${this.chainName}] tx tracker: no node supports author_pendingExtrinsics, mempool-drop detection disabled (reorg-loss detection is unaffected)`);
					this.warnedNoUnsafeRpc = true;
				}
				return;
			}
			this.warnedNoUnsafeRpc = false;
			this.pollPendingPool(conn).catch(() => {});
		}, this.pollIntervalMs);
	}
}
