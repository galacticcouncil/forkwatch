import * as dotenv from 'dotenv';
dotenv.config();

export const port = Number(process.env.PORT) || 3001;
export const timeout = Number(process.env.TIMEOUT) || 120;
export const pruneAfter = Number(process.env.PRUNE_FINALIZED_AFTER) || 50;
export const retentionDays = Number(process.env.RETENTION_DAYS) || 90;
export const forkEventRetentionDays = Number(process.env.FORK_EVENT_RETENTION_DAYS) || 365;
export const finalityLogInterval = Number(process.env.FINALITY_LOG_INTERVAL) || 60; // seconds
export const databaseUrl = process.env.DATABASE_URL || null;

export const txTrackingEnabled = process.env.TX_TRACKING_ENABLED !== 'false'; // kill switch, default on
export const mempoolPollIntervalMs = Number(process.env.TX_MEMPOOL_POLL_INTERVAL_MS) || 6000;
export const txReorgGracePeriodBlocks = Number(process.env.TX_REORG_GRACE_PERIOD_BLOCKS) || 10;
export const txRetentionDays = Number(process.env.TX_RETENTION_DAYS) || 180;

// auto-resubmission: replays the exact already-signed bytes for dropped/reorged-lost
// txs -- no signing ever happens, off by default. no whitelist gating; captures raw
// from every tracked transaction.
export const resubmitEnabled = process.env.RESUBMIT_ENABLED === 'true';

const presets = {
	hydration: [
		{
			name: 'polkadot',
			consensus: 'babe',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'parity', url: 'wss://rpc.polkadot.io' },
				{ name: 'dwellir', url: 'wss://polkadot-rpc.n.dwellir.com' },
				{ name: 'ibp', url: 'wss://polkadot.ibp.network' },
				{ name: 'dotters', url: 'wss://polkadot.dotters.network' },
				{ name: 'stakeworld', url: 'wss://rpc-polkadot.stakeworld.io' },
			],
			knownAuthors: {},
		},
		{
			name: 'hydration',
			consensus: 'aura',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'gc', url: 'wss://rpc.hydradx.cloud' },
				{ name: 'dwellir', url: 'wss://hydration-rpc.n.dwellir.com' },
				{ name: 'rotko', url: 'wss://hydration.rotko.net' },
				{ name: 'sin', url: 'wss://subway.sin.hydration.cloud' },
				{ name: 'coke', url: 'wss://subway.coke.hydration.cloud' },
				{ name: 'kril', url: 'wss://rpc.kril.hydration.cloud' },
				{ name: 'sf', url: 'wss://subway.shellfish.hydration.cloud' },
				{ name: 'cf-1', url: 'wss://rpc-catfish-1.catfish.hydration.cloud' },
				{ name: 'cf-2', url: 'wss://rpc-catfish-2.catfish.hydration.cloud' },
				{ name: 'cf-3', url: 'wss://rpc-catfish-3.catfish.hydration.cloud' },
				{ name: 'cf-4', url: 'wss://rpc-catfish-4.catfish.hydration.cloud' },
				{ name: 'tarn', url: 'wss://hdx.tarn.hydration.cloud' },
			],
			knownAuthors: {},
		},
		{
			name: 'assethub',
			consensus: 'aura',
			blockTimeMs: 2000, // elastic scaling, constants report 12s but actual is ~2s
			nodes: [
				{ name: 'parity', url: 'wss://polkadot-asset-hub-rpc.polkadot.io' },
				{ name: 'dwellir', url: 'wss://asset-hub-polkadot-rpc.n.dwellir.com' },
				{ name: 'ibp', url: 'wss://asset-hub-polkadot.ibp.network' },
				{ name: 'dotters', url: 'wss://asset-hub-polkadot.dotters.network' },
				{ name: 'luckyfriday', url: 'wss://rpc-asset-hub-polkadot.luckyfriday.io' },
			],
			knownAuthors: {},
		},
		{
			name: 'moonbeam',
			consensus: 'aura',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'moonbeam-foundation', url: 'wss://wss.api.moonbeam.network' },
				{ name: 'dwellir', url: 'wss://moonbeam-rpc.n.dwellir.com' },
				{ name: 'dotters', url: 'wss://moonbeam.dotters.network' },
				{ name: 'ibp', url: 'wss://moonbeam.ibp.network' },
				{ name: 'unitedbloc', url: 'wss://moonbeam.unitedbloc.com' },
			],
			knownAuthors: {},
		},
		{
			name: 'interlay',
			consensus: 'aura',
			blockTimeMs: 12000,
			nodes: [
				{ name: 'kintsugi-labs', url: 'wss://api.interlay.io/parachain' },
				{ name: 'luckyfriday', url: 'wss://rpc-interlay.luckyfriday.io' },
			],
			knownAuthors: {},
		},
		{
			name: 'bifrost',
			consensus: 'aura',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'liebi', url: 'wss://hk.p.bifrost-rpc.liebi.com/ws' },
				{ name: 'liebi-us', url: 'wss://us.bifrost-rpc.liebi.com/ws' },
				{ name: 'ibp', url: 'wss://bifrost-polkadot.ibp.network' },
			],
			knownAuthors: {},
		},
	],
	basilisk: [
		{
			name: 'kusama',
			consensus: 'babe',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'parity', url: 'wss://kusama-rpc.polkadot.io' },
				{ name: 'dwellir', url: 'wss://kusama-rpc.n.dwellir.com' },
				{ name: 'ibp', url: 'wss://kusama.ibp.network' },
				{ name: 'dotters', url: 'wss://kusama.dotters.network' },
				{ name: 'stakeworld', url: 'wss://rpc-kusama.stakeworld.io' },
			],
			knownAuthors: {},
		},
		{
			name: 'basilisk',
			consensus: 'aura',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'gc', url: 'wss://rpc.basilisk.cloud' },
				{ name: 'dwellir', url: 'wss://basilisk-rpc.n.dwellir.com' },
			],
			knownAuthors: {},
		},
		{
			name: 'assethub-kusama',
			consensus: 'aura',
			blockTimeMs: 2000, // elastic scaling
			nodes: [
				{ name: 'parity', url: 'wss://kusama-asset-hub-rpc.polkadot.io' },
				{ name: 'dwellir', url: 'wss://asset-hub-kusama-rpc.n.dwellir.com' },
				{ name: 'ibp', url: 'wss://asset-hub-kusama.ibp.network' },
				{ name: 'dotters', url: 'wss://asset-hub-kusama.dotters.network' },
				{ name: 'luckyfriday', url: 'wss://rpc-asset-hub-kusama.luckyfriday.io' },
			],
			knownAuthors: {},
		},
		{
			name: 'moonriver',
			consensus: 'aura',
			blockTimeMs: 6000,
			nodes: [
				{ name: 'moonbeam-foundation', url: 'wss://wss.api.moonriver.moonbeam.network' },
				{ name: 'dwellir', url: 'wss://moonriver-rpc.n.dwellir.com' },
				{ name: 'unitedbloc', url: 'wss://moonriver.unitedbloc.com' },
			],
			knownAuthors: {},
		},
	],
};

function resolveChains() {
	if (process.env.CHAINS) return JSON.parse(process.env.CHAINS);
	const preset = process.env.PRESET || 'hydration';
	if (!presets[preset]) {
		console.error(`unknown preset '${preset}', available: ${Object.keys(presets).join(', ')}`);
		process.exit(1);
	}
	return presets[preset];
}

export const chains = resolveChains();
