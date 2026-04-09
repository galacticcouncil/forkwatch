import { jest } from '@jest/globals';
import { BlockTree } from '../src/monitor/block-tree.js';
import { createMockMetrics, createMockDb } from './helpers.js';

// mock db modules
const mockDb = createMockDb();

jest.unstable_mockModule('../src/db/queries.js', () => ({
	insertForkBlock: jest.fn(async () => ({})),
	insertForkEvent: jest.fn(async () => ({})),
	resolveForkEvent: jest.fn(async () => ({})),
	insertFinalityLog: jest.fn(async () => ({})),
	getRecentForkEvents: jest.fn(async () => ({ rows: [] })),
	getBlocksAtHeight: jest.fn(async () => ({ rows: [] })),
	cleanupOldData: jest.fn(async () => ({ blocks: 0, finality: 0, events: 0 })),
}));

jest.unstable_mockModule('../src/db/index.js', () => ({
	db: () => mockDb,
	dbEnabled: () => true,
}));

const { ForkDetector } = await import('../src/monitor/fork-detector.js');
const { ForkCausation } = await import('../src/monitor/causation.js');

describe('ForkCausation', () => {
	let m;
	let parachainCtx;
	let relayChainCtx;

	function createMockCtx(name, consensus) {
		const tree = new BlockTree(name);
		const m2 = createMockMetrics();
		const detector = new ForkDetector(tree, m2, name);
		return {
			name,
			consensus,
			blockTree: tree,
			forkDetector: detector,
			connections: [],
		};
	}

	function addMockConnection(ctx, validationDataFn) {
		ctx.connections.push({
			connected: true,
			api: {
				query: {
					parachainSystem: {
						validationData: {
							at: validationDataFn,
						},
					},
				},
				rpc: {
					chain: {
						getBlock: jest.fn(),
					},
				},
			},
		});
	}

	beforeEach(() => {
		m = createMockMetrics();
		parachainCtx = createMockCtx('hydration', 'aura');
		relayChainCtx = createMockCtx('polkadot', 'babe');
		mockDb.query.mockClear();
	});

	test('hooks into fork detector onForkDetected', () => {
		const original = parachainCtx.forkDetector.onForkDetected;
		new ForkCausation(parachainCtx, relayChainCtx, m);
		expect(parachainCtx.forkDetector.onForkDetected).not.toBe(original);
	});

	test('labels fork as collator_contention when same relay parent', async () => {
		const sameRelayHash = '0xrelay_parent_aaa';

		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => sameRelayHash },
				relayParentNumber: { toNumber: () => 1000 },
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		// simulate a fork with two blocks
		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });
		blocksAtHeight.set('0xbb', { hash: '0xbb', number: 500, author: 'bob' });

		await causation.analyzeForkCause(500, blocksAtHeight);

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration',
			cause: 'collator_contention',
		});
		expect(m.parachain_forks_relay_caused_total.inc).not.toHaveBeenCalled();
	});

	test('labels fork as relay_fork when same relay number but different hashes', async () => {
		let callCount = 0;
		const relayHashes = ['0xrelay_aaa', '0xrelay_bbb'];

		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => relayHashes[callCount++] },
				relayParentNumber: { toNumber: () => 1000 }, // same relay number
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });
		blocksAtHeight.set('0xbb', { hash: '0xbb', number: 500, author: 'bob' });

		await causation.analyzeForkCause(500, blocksAtHeight);

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration',
			cause: 'relay_fork',
		});
		expect(m.parachain_forks_relay_caused_total.inc).toHaveBeenCalledWith({
			chain: 'hydration',
			relay_chain: 'polkadot',
		});
	});

	test('labels fork as collator_contention when different relay numbers', async () => {
		let callCount = 0;

		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => '0xhash_' + callCount },
				relayParentNumber: { toNumber: () => 1000 + callCount++ }, // different relay numbers
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });
		blocksAtHeight.set('0xbb', { hash: '0xbb', number: 500, author: 'bob' });

		await causation.analyzeForkCause(500, blocksAtHeight);

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration',
			cause: 'collator_contention',
		});
		expect(m.parachain_forks_relay_caused_total.inc).not.toHaveBeenCalled();
	});

	test('updates db with cause and relay_height for relay fork', async () => {
		let callCount = 0;
		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => '0xr' + callCount++ },
				relayParentNumber: { toNumber: () => 1000 }, // same relay number, different hashes
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });
		blocksAtHeight.set('0xbb', { hash: '0xbb', number: 500, author: 'bob' });

		await causation.analyzeForkCause(500, blocksAtHeight);

		// should have updated fork_events with cause
		const causeUpdate = mockDb.query.mock.calls.find(
			([sql]) => sql.includes('UPDATE fork_events SET cause')
		);
		expect(causeUpdate).toBeDefined();
		expect(causeUpdate[1][0]).toBe('relay_fork');
		expect(causeUpdate[1][2]).toBe('hydration');
		expect(causeUpdate[1][3]).toBe(500);
	});

	test('skips analysis when no connected nodes', async () => {
		// no connections added
		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });
		blocksAtHeight.set('0xbb', { hash: '0xbb', number: 500, author: 'bob' });

		await causation.analyzeForkCause(500, blocksAtHeight);

		expect(m.parachain_fork_cause_total.inc).not.toHaveBeenCalled();
	});

	test('skips analysis with fewer than 2 blocks', async () => {
		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => '0xr1' },
				relayParentNumber: { toNumber: () => 1000 },
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', { hash: '0xaa', number: 500, author: 'alice' });

		await causation.analyzeForkCause(500, blocksAtHeight);
		expect(m.parachain_fork_cause_total.inc).not.toHaveBeenCalled();
	});

	test('updates block records with relay parent hash', async () => {
		const relayHash = '0xrelay_same';
		addMockConnection(parachainCtx, jest.fn(async () => ({
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => relayHash },
				relayParentNumber: { toNumber: () => 1000 },
			}),
		})));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);

		const blockA = { hash: '0xaa', number: 500, author: 'alice' };
		const blockB = { hash: '0xbb', number: 500, author: 'bob' };
		const blocksAtHeight = new Map();
		blocksAtHeight.set('0xaa', blockA);
		blocksAtHeight.set('0xbb', blockB);

		await causation.analyzeForkCause(500, blocksAtHeight);

		// blocks should have relayParent set
		expect(blockA.relayParent).toBe(relayHash);
		expect(blockB.relayParent).toBe(relayHash);

		// db should have update calls for fork_blocks
		const blockUpdates = mockDb.query.mock.calls.filter(
			([sql]) => sql.includes('UPDATE fork_blocks SET relay_parent')
		);
		expect(blockUpdates.length).toBe(2);
	});
});
