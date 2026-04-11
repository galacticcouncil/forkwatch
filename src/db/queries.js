import { db, dbEnabled } from './index.js';

const noop = { rows: [], rowCount: 0 };

export async function insertForkBlock(block) {
	if (!dbEnabled()) return noop;
	const { chain, blockNumber, blockHash, parentHash, stateRoot, extrinsicsRoot,
		author, authorName, relayParent, relayNumber, seenBy } = block;
	return db().query(
		`INSERT INTO fork_blocks (chain, block_number, block_hash, parent_hash, state_root, extrinsics_root,
		 author, author_name, relay_parent, relay_number, seen_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 ON CONFLICT (block_hash) DO UPDATE SET seen_by = array_cat(fork_blocks.seen_by, $11)
		 RETURNING id`,
		[chain, blockNumber, blockHash, parentHash, stateRoot, extrinsicsRoot,
		 author, authorName, relayParent, relayNumber, seenBy]
	);
}

export async function insertForkEvent(event) {
	if (!dbEnabled()) return noop;
	const { chain, blockNumber, competingCount, authors, cause, relayHeight, depth } = event;
	return db().query(
		`INSERT INTO fork_events (chain, block_number, competing_count, authors, cause, relay_height, depth)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 RETURNING id`,
		[chain, blockNumber, competingCount, authors, cause, relayHeight, depth]
	);
}

export async function resolveForkEvent(chain, blockNumber, resolvedHash) {
	if (!dbEnabled()) return noop;
	return db().query(
		`UPDATE fork_events SET resolved = TRUE, resolved_at = NOW()
		 WHERE chain = $1 AND block_number <= $2 AND resolved = FALSE`,
		[chain, blockNumber]
	);
}

export async function insertFinalityLog(entry) {
	if (!dbEnabled()) return noop;
	const { chain, node, bestHeight, finalizedHeight, lag } = entry;
	return db().query(
		`INSERT INTO finality_log (chain, node, best_height, finalized_height, lag)
		 VALUES ($1, $2, $3, $4, $5)`,
		[chain, node, bestHeight, finalizedHeight, lag]
	);
}

export async function getRecentForkEvents(chain, limit = 100) {
	if (!dbEnabled()) return { rows: [] };
	const params = [limit];
	let where = '';
	if (chain) {
		where = 'WHERE chain = $2';
		params.push(chain);
	}
	return db().query(
		`SELECT * FROM fork_events ${where} ORDER BY detected_at DESC LIMIT $1`,
		params
	);
}

export async function getBlocksAtHeight(chain, height) {
	if (!dbEnabled()) return { rows: [] };
	return db().query(
		`SELECT * FROM fork_blocks WHERE chain = $1 AND block_number = $2 ORDER BY imported_at`,
		[chain, height]
	);
}

export async function cleanupOldData(retentionDays, forkEventRetentionDays) {
	if (!dbEnabled()) return { blocks: 0, finality: 0, events: 0 };
	const blockResult = await db().query(
		`DELETE FROM fork_blocks WHERE imported_at < NOW() - INTERVAL '1 day' * $1`,
		[retentionDays]
	);
	const finalityResult = await db().query(
		`DELETE FROM finality_log WHERE recorded_at < NOW() - INTERVAL '1 day' * $1`,
		[retentionDays]
	);
	const eventResult = await db().query(
		`DELETE FROM fork_events WHERE detected_at < NOW() - INTERVAL '1 day' * $1`,
		[forkEventRetentionDays]
	);
	return {
		blocks: blockResult.rowCount,
		finality: finalityResult.rowCount,
		events: eventResult.rowCount
	};
}
