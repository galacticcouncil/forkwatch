import { jest } from '@jest/globals';
import { BlockTree } from '../src/monitor/block-tree.js';
import { createMockMetrics } from './helpers.js';

const insertSubmittedTx = jest.fn(async () => ({}));
const insertResubmitAttempt = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/db/queries.js', () => ({ insertSubmittedTx, insertResubmitAttempt }));

const extractTrackedExtrinsics = jest.fn();
jest.unstable_mockModule('../src/monitor/extrinsic-utils.js', () => ({ extractTrackedExtrinsics }));

const { TxTracker } = await import('../src/monitor/tx-tracker.js');

// resubmitOnce is fire-and-forget from tick() -- flush pending microtasks
// (the awaited submitExtrinsic call and its .then chain) before asserting.
function flushMicrotasks() {
	return new Promise(resolve => setImmediate(resolve));
}

function fakeApi(getBlockExtrinsics = () => []) {
	return {
		rpc: {
			chain: {
				getBlock: jest.fn(async () => ({ block: { extrinsics: getBlockExtrinsics() } })),
			},
			author: {
				pendingExtrinsics: jest.fn(async () => []),
				submitExtrinsic: jest.fn(async () => ({ toHex: () => '0xresubmitted' })),
			},
		},
	};
}

function fakeConn(api, nodeName = 'node-1') {
	return { api, nodeName, connected: true };
}

function substrateTx(overrides = {}) {
	return {
		kind: 'substrate', signer: 'alice', nonce: 5, hash: '0xaaa',
		section: 'balances', method: 'transfer', era: null,
		...overrides,
	};
}

describe('TxTracker', () => {
	let m;
	let tracker;

	beforeEach(() => {
		m = createMockMetrics();
		tracker = new TxTracker('test-chain', m, { dropGracePolls: 2, dropMaxWaitPolls: 3, reorgGracePeriodBlocks: 2 });
		jest.clearAllMocks();
	});

	describe('onNewBlock', () => {
		test('captures extrinsics and marks them included', async () => {
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			const api = fakeApi();

			await tracker.onNewBlock(api, '0xblock1', 100);

			expect(tracker.includedHashes.has('0xaaa')).toBe(true);
			expect(m.tx_tracked_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' }, 1);
		});

		test('does not throw when getBlock fails', async () => {
			const api = { rpc: { chain: { getBlock: jest.fn(async () => { throw new Error('boom'); }) } } };
			await expect(tracker.onNewBlock(api, '0xblock1', 100)).resolves.toBeUndefined();
		});
	});

	describe('mempool drop detection', () => {
		test('a cleanly included tx never becomes a problem row', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn); // seen pending

			// included before it ever leaves the pool
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.onNewBlock(api, '0xblock1', 101);

			extractTrackedExtrinsics.mockReturnValue([]); // vanished from pool
			await tracker.pollPendingPool(conn);
			await tracker.pollPendingPool(conn);
			await tracker.pollPendingPool(conn);

			expect(insertSubmittedTx).not.toHaveBeenCalled();
		});

		test('finalizes as dropped after the max wait window with no resubmission', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn); // seen pending

			extractTrackedExtrinsics.mockReturnValue([]); // vanished, never resubmitted
			for (let i = 0; i < 4; i++) await tracker.pollPendingPool(conn);

			expect(m.tx_dropped_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(insertSubmittedTx).toHaveBeenCalledWith(expect.objectContaining({
				chain: 'test-chain', signer: 'alice', nonce: 5, status: 'dropped', firstHash: '0xaaa',
			}));
		});

		test('classifies as expired instead of dropped once the mortal era has passed', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);
			const mortalTx = substrateTx({ era: { birth: 90, death: 95 } });

			extractTrackedExtrinsics.mockReturnValueOnce([mortalTx]);
			await tracker.pollPendingPool(conn);

			tracker.lastKnownHeight = 200; // well past death block 95
			extractTrackedExtrinsics.mockReturnValue([]);
			for (let i = 0; i < 4; i++) await tracker.pollPendingPool(conn);

			expect(m.tx_expired_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(m.tx_dropped_total.inc).not.toHaveBeenCalled();
			expect(insertSubmittedTx).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
		});

		test('links a mempool drop to its resubmission by (signer, nonce)', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ hash: '0xaaa' })]);
			await tracker.pollPendingPool(conn); // original seen pending

			extractTrackedExtrinsics.mockReturnValue([]);
			await tracker.pollPendingPool(conn); // vanished, poll 1
			await tracker.pollPendingPool(conn); // poll 2 -- crosses dropGracePolls(2)

			// resubmission gets included and finalized
			const tree = new BlockTree('test-chain');
			tree.addBlock('0xblock1', 100, '0xgenesis', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ hash: '0xbbb' })]);
			await tracker.onNewBlock(api, '0xblock1', 100);
			tracker.onHeightFinalized(100, '0xblock1', tree);

			extractTrackedExtrinsics.mockReturnValue([]);
			await tracker.pollPendingPool(conn); // poll 3 -- should now see the resubmission

			expect(m.tx_resubmitted_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(insertSubmittedTx).toHaveBeenCalledWith(expect.objectContaining({
				status: 'resubmitted', firstHash: '0xaaa', lastHash: '0xbbb',
			}));
		});

		test('a reappearing hash needs reappearDebouncePolls consecutive present-polls before clearing', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.pollPendingPool(conn); // vanished
			expect(tracker.missingCandidates.has('0xaaa')).toBe(true);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn); // reappeared once -- not enough yet (default debounce is 2)
			expect(tracker.missingCandidates.has('0xaaa')).toBe(true);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn); // reappeared a second consecutive time -- now cleared
			expect(tracker.missingCandidates.has('0xaaa')).toBe(false);
		});

		test('a single-poll flicker does not reset the missing-since clock or restart the retry loop', async () => {
			const wtracker = new TxTracker('test-chain', m, {
				dropGracePolls: 2, dropMaxWaitPolls: 4, reorgGracePeriodBlocks: 2,
				resubmitEnabled: true,
			});
			const api = fakeApi();
			const conn = fakeConn(api);
			wtracker.getConnections = () => [conn];

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn); // seen pending

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.pollPendingPool(conn); // missing count 1
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.pollPendingPool(conn); // missing count 2 -- crosses dropGracePolls, retry starts
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn); // flickers back for one poll (not 2 consecutive)
			expect(wtracker.missingCandidates.has('0xaaa')).toBe(true); // still tracked, not cleared
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(true); // retry loop was not torn down

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.pollPendingPool(conn); // missing again -- clock resumes from where it left off, not from 0
			extractTrackedExtrinsics.mockReturnValue([]);
			await wtracker.pollPendingPool(conn); // crosses dropMaxWaitPolls(4) despite the flicker

			expect(m.tx_dropped_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			// only one retry loop ever started for this hash -- not restarted by the flicker
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);
		});

		test('does not advance missingSincePollCount on a poll where the candidate is present', async () => {
			// a transaction that is genuinely alive but flickering in and out of
			// this one node's view must not reach the drop threshold at the same
			// rate as one that is truly and continuously gone -- otherwise pool
			// flicker (exactly what "already imported"/"temporarily banned"
			// rejections on resubmission suggest is happening) produces false
			// positive drop/expired classifications.
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(fakeConn(fakeApi())); // seen pending

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.pollPendingPool(fakeConn(fakeApi())); // missing -- count goes to 1
			expect(tracker.missingCandidates.get('0xaaa').missingSincePollCount).toBe(1);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(fakeConn(fakeApi())); // present again (not yet debounced-clear)
			expect(tracker.missingCandidates.get('0xaaa').missingSincePollCount).toBe(1); // unchanged, not 2

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.pollPendingPool(fakeConn(fakeApi())); // missing again
			expect(tracker.missingCandidates.get('0xaaa').missingSincePollCount).toBe(2); // resumes from 1, not 0
		});
	});

	describe('reorg-loss detection', () => {
		function forkedTree() {
			const tree = new BlockTree('test-chain');
			tree.addBlock('0x99', 99, '0x98', null, null, null, 'node-1');
			tree.addBlock('0xa1', 100, '0x99', null, null, null, 'node-1'); // winner
			tree.addBlock('0xa2', 100, '0x99', null, null, null, 'node-1'); // loser
			return tree;
		}

		test('a tx included only on the losing branch is reorged_lost if never resubmitted', async () => {
			const tree = forkedTree();
			const api = fakeApi();

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'bob', nonce: 2, hash: '0xlost' })]);
			await tracker.onNewBlock(api, '0xa2', 100);

			tracker.onHeightFinalized(100, '0xa1', tree); // queues the reorg review, dueAtHeight = 102

			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xb1', 101);
			tracker.onHeightFinalized(101, '0xb1', tree);

			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xc1', 102);
			tracker.onHeightFinalized(102, '0xc1', tree); // due -- no resubmission ever seen

			expect(m.tx_reorged_lost_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(insertSubmittedTx).toHaveBeenCalledWith(expect.objectContaining({
				status: 'reorged_lost', firstHash: '0xlost', lostAtHeight: 100, lostAtHash: '0xa2',
			}));
		});

		test('a tx included only on the losing branch links to its resubmission on the canonical chain', async () => {
			const tree = forkedTree();
			const api = fakeApi();

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'bob', nonce: 2, hash: '0xlost' })]);
			await tracker.onNewBlock(api, '0xa2', 100);
			tracker.onHeightFinalized(100, '0xa1', tree);

			// resubmission lands on the canonical branch at height 101
			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'bob', nonce: 2, hash: '0xresubmit' })]);
			await tracker.onNewBlock(api, '0xb1', 101);
			tracker.onHeightFinalized(101, '0xb1', tree); // marks 0xb1 canonical -> latestBySignerNonce updated

			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xc1', 102);
			tracker.onHeightFinalized(102, '0xc1', tree); // due -- should find the resubmission

			expect(m.tx_reorged_resubmitted_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(insertSubmittedTx).toHaveBeenCalledWith(expect.objectContaining({
				status: 'reorged_resubmitted', firstHash: '0xlost', lastHash: '0xresubmit',
			}));
		});

		test('the exact same hash reappearing on the canonical chain is not alerted on', async () => {
			const tree = forkedTree();
			const api = fakeApi();

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'carol', nonce: 9, hash: '0xsame' })]);
			await tracker.onNewBlock(api, '0xa2', 100);
			tracker.onHeightFinalized(100, '0xa1', tree);

			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'carol', nonce: 9, hash: '0xsame' })]);
			await tracker.onNewBlock(api, '0xb1', 101);
			tracker.onHeightFinalized(101, '0xb1', tree);

			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xc1', 102);
			tracker.onHeightFinalized(102, '0xc1', tree);

			expect(insertSubmittedTx).not.toHaveBeenCalled();
			expect(m.tx_reorged_lost_total.inc).not.toHaveBeenCalled();
			expect(m.tx_reorged_resubmitted_total.inc).not.toHaveBeenCalled();
		});

		test('the winning block at a forked height is never treated as a loss', async () => {
			const tree = forkedTree();
			const api = fakeApi();

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'dave', nonce: 1, hash: '0xwon' })]);
			await tracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xa2', 100);
			tracker.onHeightFinalized(100, '0xa1', tree);

			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xb1', 101);
			tracker.onHeightFinalized(101, '0xb1', tree);

			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xc1', 102);
			tracker.onHeightFinalized(102, '0xc1', tree);

			expect(insertSubmittedTx).not.toHaveBeenCalled();
		});
	});

	describe('auto-resubmission', () => {
		function tracker(opts = {}) {
			return new TxTracker('test-chain', m, {
				dropGracePolls: 2, dropMaxWaitPolls: 3, reorgGracePeriodBlocks: 2,
				resubmitEnabled: true, resubmitRetryIntervalMs: 1000, maxResubmitRetries: 3,
				...opts,
			});
		}

		afterEach(() => {
			jest.useRealTimers();
		});

		test('does not retry below the drop-noise threshold, then fires immediately once it crosses', async () => {
			const wtracker = tracker();
			const api = fakeApi();
			const conn = fakeConn(api);
			wtracker.getConnections = () => [conn];

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn); // seen pending

			extractTrackedExtrinsics.mockReturnValue([]); // vanished
			await wtracker.pollPendingPool(conn); // missing count 1, below dropGracePolls(2)
			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();

			await wtracker.pollPendingPool(conn); // missing count 2, crosses threshold -> immediate retry
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledWith('0xrawbytes');
			expect(m.tx_resubmit_attempted_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			await flushMicrotasks();
			expect(insertResubmitAttempt).toHaveBeenCalledWith(expect.objectContaining({
				signer: 'alice', hash: '0xaaa', trigger: 'mempool_drop', result: 'succeeded',
			}));

			wtracker.stopResubmitRetry('0xaaa');
		});

		test('any tracked tx with raw data gets resubmitted (no whitelist gating)', async () => {
			const wtracker = tracker(); // no whitelist, every tx with raw is eligible
			const api = fakeApi();
			const conn = fakeConn(api);
			wtracker.getConnections = () => [conn];

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'mallory', raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValue([]);
			for (let i = 0; i < 4; i++) await wtracker.pollPendingPool(conn);

			expect(m.tx_resubmit_attempted_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledWith('0xrawbytes');
		});

		test('does nothing when resubmitEnabled is false', async () => {
			const wtracker = tracker({ resubmitEnabled: false });
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValue([]);
			for (let i = 0; i < 4; i++) await wtracker.pollPendingPool(conn);

			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();
		});

		test('fires immediately on reorg loss, before the classification grace period elapses', async () => {
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];
			const tree = new BlockTree('test-chain');
			tree.addBlock('0x99', 99, '0x98', null, null, null, 'node-1');
			tree.addBlock('0xa1', 100, '0x99', null, null, null, 'node-1'); // winner
			tree.addBlock('0xa2', 100, '0x99', null, null, null, 'node-1'); // loser

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.onNewBlock(api, '0xa2', 100);

			// classification is still pending (dueAtHeight = 102) at this point,
			// but the resubmit should already have fired
			wtracker.onHeightFinalized(100, '0xa1', tree);
			await flushMicrotasks();

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledWith('0xrawbytes');
			expect(insertResubmitAttempt).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'reorg_loss' }));
			expect(m.tx_reorged_lost_total.inc).not.toHaveBeenCalled(); // not classified yet

			wtracker.stopResubmitRetry('0xaaa');
		});

		test('stops retrying once the exact same hash gets included', async () => {
			jest.useFakeTimers();
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			wtracker.startResubmitRetry(record);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);

			wtracker.latestBySignerNonce.set(wtracker.key('alice', 1), { hash: '0xaaa', blockNumber: 5 }); // succeeded, now canonical
			await jest.advanceTimersByTimeAsync(1000);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1); // no further attempts

			await jest.advanceTimersByTimeAsync(5000);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false);

			// the actual rescue signal -- distinct from resubmitOnce's "succeeded"
			// (pool-accepted, observed in production to often NOT survive to
			// inclusion) -- only fires once we've actually attempted a resubmit
			expect(m.tx_resubmit_confirmed_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(insertResubmitAttempt).toHaveBeenCalledWith(expect.objectContaining({
				hash: '0xaaa', result: 'confirmed',
			}));
		});

		test('does not record a confirmed inclusion if it resolved before any attempt was made', async () => {
			jest.useFakeTimers();
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			// already canonical before startResubmitRetry's own immediate tick runs
			wtracker.latestBySignerNonce.set(wtracker.key('alice', 1), { hash: '0xaaa', blockNumber: 5 });
			wtracker.startResubmitRetry(record);

			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();
			expect(m.tx_resubmit_confirmed_total.inc).not.toHaveBeenCalled();
		});

		test('stops retrying once a different hash resolves the same (signer, nonce)', async () => {
			jest.useFakeTimers();
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			wtracker.startResubmitRetry(record);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);

			// a different hash for the same (signer, nonce) is now canonical
			wtracker.latestBySignerNonce.set(wtracker.key('alice', 1), { hash: '0xbbb', blockNumber: 5 });
			await jest.advanceTimersByTimeAsync(5000);

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1); // no further attempts
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false);
		});

		test('stops retrying once the mortal era has expired', async () => {
			jest.useFakeTimers();
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = {
				signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate',
				era: { birth: 90, death: 95 },
			};
			wtracker.startResubmitRetry(record);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);

			wtracker.lastKnownHeight = 200; // well past death block 95
			await jest.advanceTimersByTimeAsync(5000);

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1); // no further attempts
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false);
		});

		test('stops after maxResubmitRetries attempts if nothing else resolves it', async () => {
			jest.useFakeTimers();
			const wtracker = tracker({ maxResubmitRetries: 3, resubmitRetryIntervalMs: 1000 });
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			wtracker.startResubmitRetry(record); // attempt 1 (immediate)

			await jest.advanceTimersByTimeAsync(1000); // attempt 2
			await jest.advanceTimersByTimeAsync(1000); // attempt 3
			await jest.advanceTimersByTimeAsync(1000); // over the cap -- should stop without a 4th attempt
			await jest.advanceTimersByTimeAsync(1000);

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(3);
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false);
		});

		test('does not start a second retry loop for a hash already being retried', async () => {
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			wtracker.startResubmitRetry(record);
			wtracker.startResubmitRetry(record);

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);
			wtracker.stopResubmitRetry('0xaaa');
		});

		test('does not start a fresh retry loop for a hash whose loop already stopped', async () => {
			// simulates a transaction landing in losing blocks at more than one
			// nearby height during a cascading reorg -- queueReorgReview can
			// legitimately call startResubmitRetry for the same hash a second
			// time, after the first retry lifecycle already completed.
			const wtracker = tracker();
			const api = fakeApi();
			wtracker.getConnections = () => [fakeConn(api)];

			const record = { signer: 'alice', nonce: 1, hash: '0xaaa', raw: '0xrawbytes', kind: 'substrate', era: null };
			wtracker.startResubmitRetry(record);
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);

			wtracker.stopResubmitRetry('0xaaa'); // loop lifecycle ends (e.g. hit its stop condition)
			wtracker.startResubmitRetry(record); // discovered again from a different height

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1); // no second attempt
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false); // and no loop was restarted
		});
	});

	describe('pruneBlocks', () => {
		test('removes captured block extrinsics and processed fork heights below threshold', async () => {
			const api = fakeApi();
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.onNewBlock(api, '0xaa', 100);
			tracker.processedForkHeights.add(50);
			tracker.processedForkHeights.add(150);

			tracker.pruneBlocks(100);

			expect(tracker.blockExtrinsics.has('0xaa')).toBe(false);
			expect(tracker.processedForkHeights.has(50)).toBe(false);
			expect(tracker.processedForkHeights.has(150)).toBe(true);
		});

		test('does not kill a mempool-drop retry loop immediately (lostAtHeight must be a real height, not null)', async () => {
			// regression: mempool-drop candidates used to have no lostAtHeight at
			// all, so startResubmitRetry stored `null`, and pruneBlocks's safety
			// check `entry.lostAtHeight <= belowHeight` coerced null to 0 -- true
			// for almost any belowHeight, killing the retry loop within one
			// finalized-heads event instead of giving it its intended window.
			const wtracker = new TxTracker('test-chain', m, {
				dropGracePolls: 2, dropMaxWaitPolls: 20, resubmitEnabled: true,
			});
			const api = fakeApi();
			const conn = fakeConn(api);
			wtracker.getConnections = () => [conn];
			wtracker.lastKnownHeight = 1000;

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn);
			extractTrackedExtrinsics.mockReturnValue([]);
			await wtracker.pollPendingPool(conn);
			await wtracker.pollPendingPool(conn); // crosses dropGracePolls, retry starts at height 1000

			expect(wtracker.resubmitRetryTimers.get('0xaaa').lostAtHeight).toBe(1000);

			wtracker.pruneBlocks(990); // well below 1000 -- should NOT stop the loop
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(true);

			wtracker.pruneBlocks(1000); // now at/past it -- should stop it
			expect(wtracker.resubmitRetryTimers.has('0xaaa')).toBe(false);
		});
	});

	describe('start', () => {
		test('logs once and skips polling when no connections exist', () => {
			jest.useFakeTimers();
			const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

			tracker.start(() => []);
			jest.advanceTimersByTime(tracker.pollIntervalMs * 3);

			expect(logSpy).toHaveBeenCalledTimes(1);
			logSpy.mockRestore();
			jest.useRealTimers();
		});
	});

	describe('pickPollableConnection', () => {
		test('picks a connected node not yet known to reject the unsafe rpc', () => {
			const conns = [fakeConn(fakeApi(), 'node-a'), fakeConn(fakeApi(), 'node-b')];
			expect(tracker.pickPollableConnection(conns).nodeName).toBe('node-a');
		});

		test('skips nodes marked unsupported after a failed poll', async () => {
			const badApi = { rpc: { author: { pendingExtrinsics: jest.fn(async () => { throw new Error('unsafe rpc rejected'); }) } } };
			const goodApi = fakeApi();
			const bad = fakeConn(badApi, 'node-a');
			const good = fakeConn(goodApi, 'node-b');

			extractTrackedExtrinsics.mockReturnValue([]);
			await tracker.pollPendingPool(bad);

			expect(tracker.pickPollableConnection([bad, good]).nodeName).toBe('node-b');
		});

		test('ignores disconnected nodes', () => {
			const conns = [{ ...fakeConn(fakeApi(), 'node-a'), connected: false }, fakeConn(fakeApi(), 'node-b')];
			expect(tracker.pickPollableConnection(conns).nodeName).toBe('node-b');
		});
	});
});
