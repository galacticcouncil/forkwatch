import { jest } from '@jest/globals';
import { BlockTree } from '../src/monitor/block-tree.js';
import { createMockMetrics } from './helpers.js';

const insertSubmittedTx = jest.fn(async () => ({}));
jest.unstable_mockModule('../src/db/queries.js', () => ({ insertSubmittedTx }));

const extractTrackedExtrinsics = jest.fn();
jest.unstable_mockModule('../src/monitor/extrinsic-utils.js', () => ({ extractTrackedExtrinsics }));

const { TxTracker } = await import('../src/monitor/tx-tracker.js');

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

		test('a reappearing hash clears its missing-candidate state', async () => {
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await tracker.pollPendingPool(conn); // vanished
			expect(tracker.missingCandidates.has('0xaaa')).toBe(true);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx()]);
			await tracker.pollPendingPool(conn); // reappeared
			expect(tracker.missingCandidates.has('0xaaa')).toBe(false);
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
		function whitelistedTracker(overrides = {}) {
			return new TxTracker('test-chain', m, {
				dropGracePolls: 2, dropMaxWaitPolls: 3, reorgGracePeriodBlocks: 2,
				resubmitEnabled: true, resubmitWhitelist: new Set(['alice']),
				...overrides,
			});
		}

		test('replays the exact raw bytes for a whitelisted signer once a drop finalizes', async () => {
			const wtracker = whitelistedTracker();
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn); // seen pending

			extractTrackedExtrinsics.mockReturnValue([]); // vanished, never resubmitted by the wallet itself
			for (let i = 0; i < 4; i++) await wtracker.pollPendingPool(conn);

			expect(m.tx_dropped_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledWith('0xrawbytes');
			expect(m.tx_resubmit_attempted_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
		});

		test('does not resubmit a signer not on the whitelist', async () => {
			const wtracker = whitelistedTracker(); // whitelist only has 'alice'
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ signer: 'mallory', raw: null })]);
			await wtracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValue([]);
			for (let i = 0; i < 4; i++) await wtracker.pollPendingPool(conn);

			expect(m.tx_dropped_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();
		});

		test('does nothing when resubmitEnabled is false, even for a whitelisted signer', async () => {
			const wtracker = whitelistedTracker({ resubmitEnabled: false });
			const api = fakeApi();
			const conn = fakeConn(api);

			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.pollPendingPool(conn);

			extractTrackedExtrinsics.mockReturnValue([]);
			for (let i = 0; i < 4; i++) await wtracker.pollPendingPool(conn);

			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();
		});

		test('resubmits a reorged_lost tx for a whitelisted signer', async () => {
			const wtracker = whitelistedTracker();
			const api = fakeApi();
			const tree = new BlockTree('test-chain');
			tree.addBlock('0x99', 99, '0x98', null, null, null, 'node-1');
			tree.addBlock('0xa1', 100, '0x99', null, null, null, 'node-1'); // winner
			tree.addBlock('0xa2', 100, '0x99', null, null, null, 'node-1'); // loser

			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.onNewBlock(api, '0xa1', 100);
			extractTrackedExtrinsics.mockReturnValueOnce([substrateTx({ raw: '0xrawbytes' })]);
			await wtracker.onNewBlock(api, '0xa2', 100);
			wtracker.onHeightFinalized(100, '0xa1', tree);

			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.onNewBlock(api, '0xb1', 101);
			wtracker.onHeightFinalized(101, '0xb1', tree);

			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			extractTrackedExtrinsics.mockReturnValueOnce([]);
			await wtracker.onNewBlock(api, '0xc1', 102);
			wtracker.onHeightFinalized(102, '0xc1', tree); // due -- no resubmission ever seen

			expect(m.tx_reorged_lost_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledWith('0xrawbytes');
		});

		test('does not resubmit a resolved resubmission or an expired tx', () => {
			const wtracker = whitelistedTracker();
			const api = fakeApi();
			wtracker.activeApi = api;

			wtracker.finalize({ signer: 'alice', nonce: 1, raw: '0xa', kind: 'substrate' }, '0xa', 'expired', {});
			wtracker.finalize({ signer: 'alice', nonce: 2, raw: '0xb', kind: 'substrate' }, '0xb', 'resubmitted', { replacedBy: '0xc' });

			expect(api.rpc.author.submitExtrinsic).not.toHaveBeenCalled();
		});

		test('only attempts a resubmission once per original hash', () => {
			const wtracker = whitelistedTracker();
			const api = fakeApi();
			wtracker.activeApi = api;
			const record = { signer: 'alice', nonce: 1, raw: '0xa', kind: 'substrate' };

			wtracker.attemptResubmission(record, '0xa');
			wtracker.attemptResubmission(record, '0xa');

			expect(api.rpc.author.submitExtrinsic).toHaveBeenCalledTimes(1);
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
