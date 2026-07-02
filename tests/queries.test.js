import { jest } from '@jest/globals';

// mock the db pool before importing queries
const mockQuery = jest.fn(async () => ({ rows: [], rowCount: 0 }));

jest.unstable_mockModule('../src/db/index.js', () => ({
	db: () => ({ query: mockQuery }),
	dbEnabled: () => true,
	initDb: jest.fn(),
	closeDb: jest.fn(),
}));

const {
	insertForkBlock,
	insertForkEvent,
	resolveForkEvent,
	insertFinalityLog,
	getRecentForkEvents,
	getBlocksAtHeight,
	cleanupOldData,
	insertSubmittedTx,
	getSubmittedTxs,
	getSubmittedTxsBySigner,
} = await import('../src/db/queries.js');

describe('db/queries', () => {
	beforeEach(() => {
		mockQuery.mockClear();
		mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
	});

	describe('insertForkBlock', () => {
		test('inserts with correct params', async () => {
			await insertForkBlock({
				chain: 'hydration',
				blockNumber: 100,
				blockHash: '0xaa',
				parentHash: '0x99',
				stateRoot: '0xstate',
				extrinsicsRoot: '0xextr',
				author: 'alice',
				authorName: 'alice-name',
				relayParent: '0xrelay',
				relayNumber: 5000,
				seenBy: ['node-1'],
			});

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('INSERT INTO fork_blocks');
			expect(sql).toContain('ON CONFLICT (block_hash)');
			expect(params).toEqual([
				'hydration', 100, '0xaa', '0x99', '0xstate', '0xextr',
				'alice', 'alice-name', '0xrelay', 5000, ['node-1']
			]);
		});

		test('handles null optional fields', async () => {
			await insertForkBlock({
				chain: 'polkadot',
				blockNumber: 200,
				blockHash: '0xbb',
				parentHash: '0xaa',
				stateRoot: null,
				extrinsicsRoot: null,
				author: null,
				authorName: null,
				relayParent: null,
				relayNumber: null,
				seenBy: ['node-1', 'node-2'],
			});

			const [, params] = mockQuery.mock.calls[0];
			expect(params[4]).toBeNull(); // stateRoot
			expect(params[5]).toBeNull(); // extrinsicsRoot
			expect(params[6]).toBeNull(); // author
			expect(params[7]).toBeNull(); // authorName
			expect(params[8]).toBeNull(); // relayParent
			expect(params[9]).toBeNull(); // relayNumber
			expect(params[10]).toEqual(['node-1', 'node-2']);
		});
	});

	describe('insertForkEvent', () => {
		test('inserts with correct params', async () => {
			await insertForkEvent({
				chain: 'hydration',
				blockNumber: 100,
				competingCount: 2,
				authors: ['alice', 'bob'],
				cause: 'collator_contention',
				relayHeight: null,
				depth: 1,
			});

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('INSERT INTO fork_events');
			expect(params).toEqual([
				'hydration', 100, 2, ['alice', 'bob'], 'collator_contention', null, 1
			]);
		});

		test('inserts relay_fork with relay height', async () => {
			await insertForkEvent({
				chain: 'moonbeam',
				blockNumber: 500,
				competingCount: 2,
				authors: ['collator-a', 'collator-b'],
				cause: 'relay_fork',
				relayHeight: 18000000,
				depth: 1,
			});

			const [, params] = mockQuery.mock.calls[0];
			expect(params[4]).toBe('relay_fork');
			expect(params[5]).toBe(18000000);
		});
	});

	describe('resolveForkEvent', () => {
		test('resolves all events at or below finalized height', async () => {
			await resolveForkEvent('hydration', 100, '0xwinning');

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('UPDATE fork_events SET resolved = TRUE');
			expect(sql).toContain('block_number <= $2');
			expect(params).toEqual(['hydration', 100]);
		});
	});

	describe('insertFinalityLog', () => {
		test('inserts with correct params', async () => {
			await insertFinalityLog({
				chain: 'polkadot',
				node: 'parity-rpc',
				bestHeight: 18000100,
				finalizedHeight: 18000090,
				lag: 10,
			});

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('INSERT INTO finality_log');
			expect(params).toEqual(['polkadot', 'parity-rpc', 18000100, 18000090, 10]);
		});
	});

	describe('getRecentForkEvents', () => {
		test('queries without chain filter', async () => {
			await getRecentForkEvents(null, 50);

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('ORDER BY detected_at DESC');
			expect(sql).not.toContain('WHERE chain');
			expect(params).toEqual([50]);
		});

		test('queries with chain filter', async () => {
			await getRecentForkEvents('hydration', 25);

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('WHERE chain = $2');
			expect(params).toEqual([25, 'hydration']);
		});

		test('defaults to limit 100', async () => {
			await getRecentForkEvents(null);

			const [, params] = mockQuery.mock.calls[0];
			expect(params[0]).toBe(100);
		});
	});

	describe('getBlocksAtHeight', () => {
		test('queries with chain and height', async () => {
			await getBlocksAtHeight('moonbeam', 500);

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('SELECT * FROM fork_blocks');
			expect(params).toEqual(['moonbeam', 500]);
		});
	});

	describe('cleanupOldData', () => {
		test('deletes from all four tables', async () => {
			mockQuery.mockResolvedValue({ rowCount: 5 });

			const result = await cleanupOldData(90, 365, 180);

			expect(mockQuery).toHaveBeenCalledTimes(4);

			const tables = mockQuery.mock.calls.map(([sql]) => {
				if (sql.includes('fork_blocks')) return 'blocks';
				if (sql.includes('finality_log')) return 'finality';
				if (sql.includes('fork_events')) return 'events';
				if (sql.includes('submitted_txs')) return 'txs';
			});
			expect(tables.sort()).toEqual(['blocks', 'events', 'finality', 'txs']);

			expect(result).toEqual({ blocks: 5, finality: 5, events: 5, txs: 5 });
		});

		test('passes correct retention periods', async () => {
			mockQuery.mockResolvedValue({ rowCount: 0 });
			await cleanupOldData(30, 180, 90);

			const blockCall = mockQuery.mock.calls.find(([sql]) => sql.includes('fork_blocks'));
			const eventCall = mockQuery.mock.calls.find(([sql]) => sql.includes('fork_events'));
			const txCall = mockQuery.mock.calls.find(([sql]) => sql.includes('submitted_txs'));

			expect(blockCall[1]).toEqual([30]);
			expect(eventCall[1]).toEqual([180]);
			expect(txCall[1]).toEqual([90]);
		});
	});

	describe('insertSubmittedTx', () => {
		test('inserts with correct params, stringifying attempts', async () => {
			const attempts = [{ hash: '0xaaa', birth: 100, death: 164, firstSeenAt: 1000, outcome: 'dropped' }];

			await insertSubmittedTx({
				chain: 'hydration',
				signer: 'alice',
				nonce: 5,
				kind: 'substrate',
				section: 'balances',
				method: 'transfer',
				status: 'dropped',
				firstHash: '0xaaa',
				lastHash: '0xaaa',
				attempts,
				lostAtHeight: null,
				lostAtHash: null,
				resolvedHash: null,
				resolvedHeight: null,
			});

			expect(mockQuery).toHaveBeenCalledTimes(1);
			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('INSERT INTO submitted_txs');
			expect(params).toEqual([
				'hydration', 'alice', 5, 'substrate', 'balances', 'transfer', 'dropped',
				'0xaaa', '0xaaa', JSON.stringify(attempts), null, null, null, null,
			]);
		});

		test('allows null signer/nonce for unrecovered evm rows', async () => {
			await insertSubmittedTx({
				chain: 'moonbeam',
				signer: null,
				nonce: null,
				kind: 'evm',
				section: 'ethereum',
				method: 'transact',
				status: 'dropped',
				firstHash: '0xbbb',
				lastHash: '0xbbb',
				attempts: [],
				lostAtHeight: null,
				lostAtHash: null,
				resolvedHash: null,
				resolvedHeight: null,
			});

			const [, params] = mockQuery.mock.calls[0];
			expect(params[1]).toBeNull(); // signer
			expect(params[2]).toBeNull(); // nonce
			expect(params[3]).toBe('evm');
		});
	});

	describe('getSubmittedTxs', () => {
		test('queries without filters', async () => {
			await getSubmittedTxs(null, null, 50);

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('ORDER BY detected_at DESC');
			expect(sql).not.toContain('WHERE');
			expect(params).toEqual([50]);
		});

		test('queries with chain, status and kind filters', async () => {
			await getSubmittedTxs('hydration', 'dropped', 25, 'substrate');

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('chain = $1');
			expect(sql).toContain('status = $2');
			expect(sql).toContain('kind = $3');
			expect(params).toEqual(['hydration', 'dropped', 'substrate', 25]);
		});
	});

	describe('getSubmittedTxsBySigner', () => {
		test('queries with chain and signer', async () => {
			await getSubmittedTxsBySigner('moonbeam', '0xabc', 25);

			const [sql, params] = mockQuery.mock.calls[0];
			expect(sql).toContain('SELECT * FROM submitted_txs');
			expect(params).toEqual(['moonbeam', '0xabc', 25]);
		});
	});
});
