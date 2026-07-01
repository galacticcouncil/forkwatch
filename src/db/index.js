import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { databaseUrl } from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool;
let enabled = false;

export async function initDb(retries = 10, delayMs = 3000) {
	if (!databaseUrl) {
		console.log('DATABASE_URL not set, running without database');
		return;
	}

	pool = new pg.Pool({
		connectionString: databaseUrl,
		max: 10,
		idleTimeoutMillis: 30000,
	});

	pool.on('error', (err) => {
		console.error('unexpected database error:', err.message);
	});

	const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

	for (let attempt = 1; attempt <= retries; attempt++) {
		try {
			await pool.query(schema);
			enabled = true;
			console.log('database schema initialized');
			return;
		} catch (err) {
			if (attempt === retries) throw err;
			console.log(`database not ready (attempt ${attempt}/${retries}): ${err.message}`);
			await new Promise(r => setTimeout(r, delayMs));
		}
	}
}

// one-time data migrations, guarded by schema_migrations so each runs at most
// once. kept out of initDb()/schema.sql because the same_author backfill scans
// all of fork_blocks and must never block the boot / http listen again.
const migrations = [
	{
		name: 'backfill_same_author_v1',
		sql: `
			UPDATE fork_events e
			SET same_author = sub.same_author,
			    same_parent = sub.same_parent
			FROM (
			  SELECT chain, block_number,
			    count(DISTINCT coalesce(author_name, author)) = 1 AS same_author,
			    count(DISTINCT parent_hash) = 1 AS same_parent
			  FROM fork_blocks
			  GROUP BY chain, block_number
			  HAVING count(*) > 1
			) sub
			WHERE e.chain = sub.chain
			  AND e.block_number = sub.block_number
			  AND e.same_author IS NULL;
		`,
	},
];

export async function runMigrations() {
	if (!enabled) return;
	for (const { name, sql } of migrations) {
		const done = await pool.query(
			'SELECT 1 FROM schema_migrations WHERE name = $1',
			[name]
		);
		if (done.rowCount > 0) continue;
		console.log(`running migration: ${name}`);
		await pool.query(sql);
		await pool.query(
			'INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING',
			[name]
		);
		console.log(`migration complete: ${name}`);
	}
}

export function dbEnabled() {
	return enabled;
}

export function db() {
	if (!pool) {
		throw new Error('database not initialized');
	}
	return pool;
}

export async function closeDb() {
	if (pool) {
		await pool.end();
		pool = null;
		enabled = false;
	}
}
