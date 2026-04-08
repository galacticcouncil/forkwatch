import { BlockTree } from '../src/monitor/block-tree.js';

describe('BlockTree', () => {
	let tree;

	beforeEach(() => {
		tree = new BlockTree('test-chain');
	});

	describe('addBlock', () => {
		test('adds a new block and returns isNew=true', () => {
			const { record, isNew } = tree.addBlock('0xaa', 100, '0x99', 'alice', 'alice-name', null, 'node-1');
			expect(isNew).toBe(true);
			expect(record.hash).toBe('0xaa');
			expect(record.number).toBe(100);
			expect(record.parentHash).toBe('0x99');
			expect(record.author).toBe('alice');
			expect(record.authorName).toBe('alice-name');
			expect(record.seenByNodes.has('node-1')).toBe(true);
		});

		test('returns isNew=false for duplicate block hash', () => {
			tree.addBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			const { isNew } = tree.addBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-2');
			expect(isNew).toBe(false);
		});

		test('adds second node to seenByNodes on duplicate', () => {
			tree.addBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			const { record } = tree.addBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-2');
			expect(record.seenByNodes.has('node-1')).toBe(true);
			expect(record.seenByNodes.has('node-2')).toBe(true);
		});

		test('updates bestHeight', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			expect(tree.bestHeight).toBe(100);
			tree.addBlock('0xbb', 101, '0xaa', null, null, null, 'node-1');
			expect(tree.bestHeight).toBe(101);
		});

		test('does not lower bestHeight', () => {
			tree.addBlock('0xbb', 101, '0xaa', null, null, null, 'node-1');
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			expect(tree.bestHeight).toBe(101);
		});

		test('stores relayParent', () => {
			const { record } = tree.addBlock('0xaa', 100, '0x99', null, null, '0xrelay', 'node-1');
			expect(record.relayParent).toBe('0xrelay');
		});
	});

	describe('getBlocksAtHeight', () => {
		test('returns undefined for empty height', () => {
			expect(tree.getBlocksAtHeight(100)).toBeUndefined();
		});

		test('returns map of blocks at height', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			const blocks = tree.getBlocksAtHeight(100);
			expect(blocks.size).toBe(1);
			expect(blocks.has('0xaa')).toBe(true);
		});

		test('returns multiple blocks at same height (fork)', () => {
			tree.addBlock('0xaa', 100, '0x99', 'alice', null, null, 'node-1');
			tree.addBlock('0xbb', 100, '0x99', 'bob', null, null, 'node-1');
			const blocks = tree.getBlocksAtHeight(100);
			expect(blocks.size).toBe(2);
		});
	});

	describe('getBlock', () => {
		test('returns block by hash', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			expect(tree.getBlock('0xaa').number).toBe(100);
		});

		test('returns undefined for unknown hash', () => {
			expect(tree.getBlock('0xzz')).toBeUndefined();
		});
	});

	describe('getForkedHeights', () => {
		test('returns empty for no forks', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xbb', 101, '0xaa', null, null, null, 'node-1');
			expect(tree.getForkedHeights()).toEqual([]);
		});

		test('returns heights with forks', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xbb', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xcc', 101, '0xaa', null, null, null, 'node-1');
			expect(tree.getForkedHeights()).toEqual([100]);
		});

		test('returns multiple forked heights sorted', () => {
			tree.addBlock('0xa1', 102, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xa2', 102, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xb1', 100, '0x98', null, null, null, 'node-1');
			tree.addBlock('0xb2', 100, '0x98', null, null, null, 'node-1');
			expect(tree.getForkedHeights()).toEqual([100, 102]);
		});
	});

	describe('measureForkDepth', () => {
		test('returns 1 for a single forked height', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xbb', 100, '0x99', null, null, null, 'node-1');
			expect(tree.measureForkDepth(100)).toBe(1);
		});

		test('returns depth for consecutive forked heights', () => {
			// fork at height 100
			tree.addBlock('0xa1', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xa2', 100, '0x99', null, null, null, 'node-1');
			// fork at height 101
			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			tree.addBlock('0xb2', 101, '0xa2', null, null, null, 'node-1');
			// fork at height 102
			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			tree.addBlock('0xc2', 102, '0xb2', null, null, null, 'node-1');

			expect(tree.measureForkDepth(102)).toBe(3);
		});

		test('stops counting at non-forked height', () => {
			// no fork at 100
			tree.addBlock('0xa1', 100, '0x99', null, null, null, 'node-1');
			// fork at 101
			tree.addBlock('0xb1', 101, '0xa1', null, null, null, 'node-1');
			tree.addBlock('0xb2', 101, '0xa1', null, null, null, 'node-1');
			// fork at 102
			tree.addBlock('0xc1', 102, '0xb1', null, null, null, 'node-1');
			tree.addBlock('0xc2', 102, '0xb2', null, null, null, 'node-1');

			expect(tree.measureForkDepth(102)).toBe(2);
		});
	});

	describe('prune', () => {
		test('removes blocks at and below keepAboveHeight', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xbb', 101, '0xaa', null, null, null, 'node-1');
			tree.addBlock('0xcc', 102, '0xbb', null, null, null, 'node-1');

			tree.prune(101);

			expect(tree.getBlock('0xaa')).toBeUndefined();
			expect(tree.getBlock('0xbb')).toBeUndefined();
			expect(tree.getBlock('0xcc')).toBeDefined();
			expect(tree.getBlocksAtHeight(100)).toBeUndefined();
			expect(tree.getBlocksAtHeight(101)).toBeUndefined();
			expect(tree.getBlocksAtHeight(102).size).toBe(1);
		});

		test('removes forked blocks during prune', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.addBlock('0xbb', 100, '0x99', null, null, null, 'node-1');

			tree.prune(100);

			expect(tree.getBlock('0xaa')).toBeUndefined();
			expect(tree.getBlock('0xbb')).toBeUndefined();
			expect(tree.getBlocksAtHeight(100)).toBeUndefined();
		});

		test('does nothing when no blocks below threshold', () => {
			tree.addBlock('0xaa', 100, '0x99', null, null, null, 'node-1');
			tree.prune(50);
			expect(tree.getBlock('0xaa')).toBeDefined();
		});
	});
});
