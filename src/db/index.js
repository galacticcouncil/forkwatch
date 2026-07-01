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
