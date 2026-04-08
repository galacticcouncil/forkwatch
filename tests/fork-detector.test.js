import { jest } from '@jest/globals';
import { BlockTree } from '../src/monitor/block-tree.js';
import { createMockMetrics, createMockDb } from './helpers.js';

// mock the db queries module
const mockDb = createMockDb();
const insertForkBlock = jest.fn(async () => ({}));
const insertForkEvent = jest.fn(async () => ({}));

jest.unstable_mockModule('../src/db/queries.js', () => ({
	insertForkBlock,
	insertForkEvent,
	resolveForkEvent: jest.fn(async () => ({})),
	insertFinalityLog: jest.fn(async () => ({})),
	getRecentForkEvents: jest.fn(async () => ({ rows: [] })),
	getBlocksAtHeight: jest.fn(async () => ({ rows: [] })),
	cleanupOldData: jest.fn(async () => ({ blocks: 0, finality: 0, events: 0 })),
}));

const { ForkDetector } = await import('../src/monitor/fork-detector.js');

describe('ForkDetector', () => {
	let tree;
	let m;
	let detector;

	beforeEach(() => {
		tree = new BlockTree('test-chain');
		m = createMockMetrics();
		detector = new ForkDetector(tree, m, 'test-chain');
		jest.clearAllMocks();
	});

	describe('onNewBlock', () => {
		test('adds block to tree and increments import counter', async () => {
			const { record, forked } = await detector.onNewBlock(
				'0xaa', 100, '0x99', 'alice', 'alice-name', null, 'node-1'
			);
			expect(record.hash).toBe('0xaa');
			expect(forked).toBe(false);
			expect(m.blocks_imported_total.inc).toHaveBeenCalledWith({
				chain: 'test-chain', node: 'node-1'
			});
		});

		test('increments author_blocks_total when author present', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', 'alice-name', null, 'node-1');
			expect(m.author_blocks_total.inc).toHaveBeenCalledWith({
				chain: 'test-chain', author: 'alice-name'
			});
		});

		test('uses raw author when authorName is null', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			expect(m.author_blocks_total.inc).toHaveBeenCalledWith({
				chain: 'test-chain', author: 'alice'
			});
		});

		test('does not increment author_blocks_total when no author', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			expect(m.author_blocks_total.inc).not.toHaveBeenCalled();
		});

		test('skips processing for duplicate blocks', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			m.blocks_imported_total.inc.mockClear();

			const { forked } = await detector.onNewBlock('0xaa', 100, '0x99', null, null, null, 'node-2');
			expect(forked).toBe(false);
			expect(m.blocks_imported_total.inc).not.toHaveBeenCalled();
		});

		test('detects fork when second block at same height', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			const { forked } = await detector.onNewBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');
			expect(forked).toBe(true);
		});

		test('records fork metrics on detection', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');

			expect(m.fork_events_total.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
			expect(m.fork_depth.observe).toHaveBeenCalledWith({ chain: 'test-chain' }, 1);
			expect(m.active_fork_heights.inc).toHaveBeenCalledWith({ chain: 'test-chain' });
		});

		test('records author_fork_blocks_total for each competing author', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');

			expect(m.author_fork_blocks_total.inc).toHaveBeenCalledWith({
				chain: 'test-chain', author: 'alice'
			});
			expect(m.author_fork_blocks_total.inc).toHaveBeenCalledWith({
				chain: 'test-chain', author: 'bob'
			});
		});

		test('inserts fork blocks and event to db', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');

			expect(insertForkBlock).toHaveBeenCalledTimes(2);
			expect(insertForkEvent).toHaveBeenCalledTimes(1);
			expect(insertForkEvent).toHaveBeenCalledWith(expect.objectContaining({
				chain: 'test-chain',
				blockNumber: 100,
				competingCount: 2,
				authors: ['alice', 'bob'],
				depth: 1,
			}));
		});

		test('does not re-record fork at same height', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');
			jest.clearAllMocks();

			// third block at same height -- should call onForkUpdated, not onForkDetected
			await detector.onNewBlock('0xcc', 100, '0x99', 'charlie', null, null, 'node-1');
			expect(m.fork_events_total.inc).not.toHaveBeenCalled();
			expect(insertForkEvent).not.toHaveBeenCalled();
			// but should still insert the fork block
			expect(insertForkBlock).toHaveBeenCalledTimes(1);
		});
	});

	describe('onHeightFinalized', () => {
		test('decrements active_fork_heights for forked height', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', null, null, null, 'node-1');

			detector.onHeightFinalized(100);
			expect(m.active_fork_heights.dec).toHaveBeenCalledWith({ chain: 'test-chain' });
		});

		test('does not decrement for non-forked height', () => {
			detector.onHeightFinalized(100);
			expect(m.active_fork_heights.dec).not.toHaveBeenCalled();
		});
	});

	describe('pruneRecordedForks', () => {
		test('removes recorded forks below threshold', async () => {
			await detector.onNewBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			await detector.onNewBlock('0xbb', 100, '0x99', null, null, null, 'node-1');
			await detector.onNewBlock('0xcc', 200, '0xbb', null, null, null, 'node-1');
			await detector.onNewBlock('0xdd', 200, '0xbb', null, null, null, 'node-1');

			detector.pruneRecordedForks(150);

			// height 100 should be pruned, height 200 should remain
			// finalizing 100 should not decrement since it's pruned
			detector.onHeightFinalized(100);
			expect(m.active_fork_heights.dec).not.toHaveBeenCalled();

			// finalizing 200 should still work
			detector.onHeightFinalized(200);
			expect(m.active_fork_heights.dec).toHaveBeenCalled();
		});
	});

	describe('fork depth measurement', () => {
		test('reports correct depth for consecutive forks', async () => {
			// fork at 100
			await detector.onNewBlock('0xa1', 100, '0x99', null, null, null, 'node-1');
			await detector.onNewBlock('0xa2', 100, '0x99', null, null, null, 'node-1');
			// fork at 101
			await detector.onNewBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			await detector.onNewBlock('0xb2', 101, '0xa2', null, null, null, 'node-1');

			// the fork at 101 should have depth 2
			expect(m.fork_depth.observe).toHaveBeenCalledWith({ chain: 'test-chain' }, 2);
		});
	});
});
