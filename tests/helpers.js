import { jest } from '@jest/globals';

/**
 * creates a mock metrics object matching the shape registered in index.js
 */
export function createMockMetrics() {
	const metric = () => ({ inc: jest.fn(), dec: jest.fn(), set: jest.fn(), observe: jest.fn() });

	return {
		fork_events_total: metric(),
		fork_depth: metric(),
		active_fork_heights: metric(),
		author_fork_blocks_total: metric(),
		best_block_height: metric(),
		finalized_block_height: metric(),
		finality_lag_blocks: metric(),
		node_connected: metric(),
		blocks_imported_total: metric(),
		parachain_fork_cause_total: metric(),
		parachain_forks_relay_caused_total: metric(),
		collator_missed_slots_total: metric(),
		collator_produced_slots_total: metric(),
	};
}

/**
 * creates a mock db query function that records calls
 */
export function createMockDb() {
	const queries = [];
	const query = jest.fn(async (sql, params) => {
		queries.push({ sql, params });
		return { rows: [], rowCount: 0 };
	});
	return { query, queries };
}
