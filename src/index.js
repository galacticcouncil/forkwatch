import { endpoints } from './endpoints.js';
import { metrics } from './metrics.js';
import { initDb, closeDb } from './db/index.js';
import { ChainManager } from './chain/manager.js';
import { getRecentForkEvents, getBlocksAtHeight, cleanupOldData } from './db/queries.js';
import { chains, retentionDays, forkEventRetentionDays } from './config.js';

const m = metrics.register('forkwatch', {
	fork_events_total: {
		type: 'counter',
		help: 'total number of fork events detected',
		labels: ['chain'],
	},
	fork_depth: {
		type: 'histogram',
		help: 'depth of detected forks in blocks',
		labels: ['chain'],
		buckets: [1, 2, 3, 5, 10, 20],
	},
	active_fork_heights: {
		type: 'gauge',
		help: 'number of currently unresolved forked heights',
		labels: ['chain'],
	},
	author_fork_blocks_total: {
		type: 'counter',
		help: 'total blocks produced by an author that were part of a fork',
		labels: ['chain', 'author'],
	},
	author_blocks_total: {
		type: 'counter',
		help: 'total blocks produced by each author',
		labels: ['chain', 'author'],
	},
	best_block_height: {
		type: 'gauge',
		help: 'best (unfinalized) block height',
		labels: ['chain', 'node'],
	},
	finalized_block_height: {
		type: 'gauge',
		help: 'finalized block height',
		labels: ['chain', 'node'],
	},
	finality_lag_blocks: {
		type: 'gauge',
		help: 'gap between best and finalized block',
		labels: ['chain', 'node'],
	},
	node_connected: {
		type: 'gauge',
		help: 'whether a node websocket connection is active',
		labels: ['chain', 'node'],
	},
	blocks_imported_total: {
		type: 'counter',
		help: 'total blocks imported via subscribeAllHeads',
		labels: ['chain', 'node'],
	},
	parachain_fork_cause_total: {
		type: 'counter',
		help: 'parachain forks by cause',
		labels: ['chain', 'cause'],
	},
	parachain_forks_relay_caused_total: {
		type: 'counter',
		help: 'parachain forks attributed to relay chain forks',
		labels: ['chain', 'relay_chain'],
	},
});

let chainManager;

function registerApiEndpoints() {
	endpoints.registerEndpoint('status', {
		'/': {
			GET: (req, res) => {
				res.json(chainManager.getStatus());
			}
		}
	});

	endpoints.registerEndpoint('forks', {
		'/': {
			GET: async (req, res) => {
				const limit = Math.min(Number(req.query.limit) || 100, 1000);
				const result = await getRecentForkEvents(null, limit);
				res.json(result.rows);
			}
		},
		'/:chain': {
			GET: async (req, res) => {
				const limit = Math.min(Number(req.query.limit) || 100, 1000);
				const result = await getRecentForkEvents(req.params.chain, limit);
				res.json(result.rows);
			}
		}
	});

	endpoints.registerEndpoint('blocks', {
		'/:chain/:height': {
			GET: async (req, res) => {
				const result = await getBlocksAtHeight(
					req.params.chain,
					Number(req.params.height)
				);
				res.json(result.rows);
			}
		}
	});

	endpoints.registerEndpoint('health', {
		'/': {
			GET: (req, res) => {
				res.json({ status: 'ok' });
			}
		}
	});
}

function startRetentionCleanup() {
	// run daily
	setInterval(async () => {
		try {
			const result = await cleanupOldData(retentionDays, forkEventRetentionDays);
			if (result.blocks > 0 || result.finality > 0 || result.events > 0) {
				console.log(
					`retention cleanup: ${result.blocks} blocks, ` +
					`${result.finality} finality logs, ${result.events} events deleted`
				);
			}
		} catch (err) {
			console.error(`retention cleanup failed: ${err.message}`);
		}
	}, 24 * 60 * 60 * 1000);
}

async function main() {
	console.log('forkwatch starting...');

	if (chains.length === 0) {
		console.error('no chains configured. set CHAINS env variable.');
		process.exit(1);
	}

	console.log(`monitoring ${chains.length} chain(s): ${chains.map(c => c.name).join(', ')}`);

	await initDb();
	registerApiEndpoints();
	await endpoints.start();

	chainManager = new ChainManager(chains, m);
	await chainManager.start();

	startRetentionCleanup();

	console.log('forkwatch ready');
}

async function shutdown() {
	console.log('shutting down...');
	await closeDb();
	await endpoints.stop();
	process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

main().catch(err => {
	console.error('fatal error:', err);
	process.exit(1);
});
