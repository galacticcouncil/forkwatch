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

export async function cleanupOldData(retentionDays, forkEventRetentionDays, txRetentionDays) {
	if (!dbEnabled()) return { blocks: 0, finality: 0, events: 0, txs: 0 };
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
	const txResult = await db().query(
		`DELETE FROM submitted_txs WHERE detected_at < NOW() - INTERVAL '1 day' * $1`,
		[txRetentionDays]
	);
	return {
		blocks: blockResult.rowCount,
		finality: finalityResult.rowCount,
		events: eventResult.rowCount,
		txs: txResult.rowCount,
	};
}

export async function insertSubmittedTx(tx) {
	if (!dbEnabled()) return noop;
	const {
		chain, signer, nonce, kind, section, method, status,
		firstHash, lastHash, attempts,
		lostAtHeight, lostAtHash, resolvedHash, resolvedHeight,
	} = tx;
	return db().query(
		`INSERT INTO submitted_txs (chain, signer, nonce, kind, section, method, status,
		 first_hash, last_hash, attempts, lost_at_height, lost_at_hash, resolved_hash, resolved_height,
		 resolved_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
		 RETURNING id`,
		[chain, signer, nonce, kind, section, method, status,
		 firstHash, lastHash, JSON.stringify(attempts || []),
		 lostAtHeight, lostAtHash, resolvedHash, resolvedHeight]
	);
}

export async function getSubmittedTxs(chain, status, limit = 100, kind = null) {
	if (!dbEnabled()) return { rows: [] };
	const conditions = [];
	const params = [];

	if (chain) {
		params.push(chain);
		conditions.push(`chain = $${params.length}`);
	}
	if (status) {
		params.push(status);
		conditions.push(`status = $${params.length}`);
	}
	if (kind) {
		params.push(kind);
		conditions.push(`kind = $${params.length}`);
	}

	const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
	params.push(limit);

	return db().query(
		`SELECT * FROM submitted_txs ${where} ORDER BY detected_at DESC LIMIT $${params.length}`,
		params
	);
}

export async function getSubmittedTxsBySigner(chain, signer, limit = 100) {
	if (!dbEnabled()) return { rows: [] };
	return db().query(
		`SELECT * FROM submitted_txs WHERE chain = $1 AND signer = $2
		 ORDER BY detected_at DESC LIMIT $3`,
		[chain, signer, limit]
	);
}
