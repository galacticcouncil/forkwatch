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
						validationData: { at: validationDataFn },
					},
				},
				rpc: { chain: { getBlock: jest.fn() } },
			},
		});
	}

	function mockValidationData(relayNumber, relayHash) {
		return {
			isSome: true,
			unwrap: () => ({
				relayParentStorageRoot: { toHex: () => relayHash },
				relayParentNumber: { toNumber: () => relayNumber },
			}),
		};
	}

	function makeBlocks(authorA, authorB, parentA = '0x99', parentB = '0x99') {
		const blocks = new Map();
		blocks.set('0xaa', { hash: '0xaa', number: 500, parentHash: parentA, author: authorA, authorName: authorA });
		blocks.set('0xbb', { hash: '0xbb', number: 500, parentHash: parentB, author: authorB, authorName: authorB });
		return blocks;
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

	test('collator_contention: different authors, same relay context', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_same')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'bob'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'collator_contention',
		});
		expect(m.parachain_forks_relay_caused_total.inc).not.toHaveBeenCalled();
	});

	test('collator_contention: different authors, different relay heights', async () => {
		let callCount = 0;
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000 + callCount++, '0xhash_' + callCount)
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'bob'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'collator_contention',
		});
	});

	test('relay_fork: different authors, same relay number, different relay hash', async () => {
		let callCount = 0;
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_' + callCount++)
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'bob'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'relay_fork',
		});
		expect(m.parachain_forks_relay_caused_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', relay_chain: 'polkadot',
		});
	});

	test('relay_fork_same_author: same author, same relay number, different relay hash', async () => {
		let callCount = 0;
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_' + callCount++)
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'alice'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'relay_fork_same_author',
		});
		expect(m.parachain_forks_relay_caused_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', relay_chain: 'polkadot',
		});
	});

	test('double_production: same author, same relay, same parent', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_same')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'alice', '0x99', '0x99'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'double_production',
		});
	});

	test('double_production_reorg: same author, same relay, different parent', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_same')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'alice', '0xparent_a', '0xparent_b'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'double_production_reorg',
		});
	});

	test('double_production_timing: same author, different relay heights', async () => {
		let callCount = 0;
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000 + callCount++, '0xhash_' + callCount)
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'alice'));

		expect(m.parachain_fork_cause_total.inc).toHaveBeenCalledWith({
			chain: 'hydration', cause: 'double_production_timing',
		});
	});

	test('stores details json in db', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_same')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'bob'));

		const causeUpdate = mockDb.query.mock.calls.find(
			([sql]) => sql.includes('UPDATE fork_events SET cause')
		);
		expect(causeUpdate).toBeDefined();
		expect(causeUpdate[1][0]).toBe('collator_contention');
		// details is the 8th param
		const details = JSON.parse(causeUpdate[1][7]);
		expect(details.same_author).toBe(false);
		expect(details.same_relay_number).toBe(true);
		expect(details.same_relay_hash).toBe(true);
		expect(details.same_parent).toBe(true);
		expect(details.authors).toEqual(['alice', 'bob']);
	});

	test('skips analysis when no connected nodes', async () => {
		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		await causation.analyzeForkCause(500, makeBlocks('alice', 'bob'));

		expect(m.parachain_fork_cause_total.inc).not.toHaveBeenCalled();
	});

	test('skips analysis with fewer than 2 blocks', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xr1')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		const blocks = new Map();
		blocks.set('0xaa', { hash: '0xaa', number: 500, parentHash: '0x99', author: 'alice', authorName: 'alice' });

		await causation.analyzeForkCause(500, blocks);
		expect(m.parachain_fork_cause_total.inc).not.toHaveBeenCalled();
	});

	test('updates block records with relay parent hash', async () => {
		addMockConnection(parachainCtx, jest.fn(async () =>
			mockValidationData(1000, '0xrelay_same')
		));

		const causation = new ForkCausation(parachainCtx, relayChainCtx, m);
		const blocks = makeBlocks('alice', 'bob');
		await causation.analyzeForkCause(500, blocks);

		const blockA = blocks.get('0xaa');
		const blockB = blocks.get('0xbb');
		expect(blockA.relayParent).toBe('0xrelay_same');
		expect(blockB.relayParent).toBe('0xrelay_same');
	});
});
