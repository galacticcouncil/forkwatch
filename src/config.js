import * as dotenv from 'dotenv';
dotenv.config();

export const port = Number(process.env.PORT) || 3001;
export const timeout = Number(process.env.TIMEOUT) || 120;
export const pruneAfter = Number(process.env.PRUNE_FINALIZED_AFTER) || 50;
export const forkDepthAlertThreshold = Number(process.env.FORK_DEPTH_ALERT_THRESHOLD) || 3;
export const finalityLagAlertThreshold = Number(process.env.FINALITY_LAG_ALERT_THRESHOLD) || 30;
export const retentionDays = Number(process.env.RETENTION_DAYS) || 90;
export const forkEventRetentionDays = Number(process.env.FORK_EVENT_RETENTION_DAYS) || 365;
export const finalityLogInterval = Number(process.env.FINALITY_LOG_INTERVAL) || 60; // seconds
export const databaseUrl = process.env.DATABASE_URL || null;

const defaultChains = [
	{
		name: 'polkadot',
		consensus: 'babe',
		nodes: [
			{ name: 'parity-rpc', url: 'wss://rpc.polkadot.io' },
			{ name: 'dwellir-rpc', url: 'wss://polkadot-rpc.dwellir.com' },
			{ name: 'ibp-rpc', url: 'wss://rpc.ibp.network/polkadot' },
		],
		knownAuthors: {},
	},
	{
		name: 'hydration',
		consensus: 'aura',
		nodes: [
			{ name: 'gc', url: 'wss://rpc.hydradx.cloud' },
			{ name: 'dwellir', url: 'wss://hydration-rpc.n.dwellir.com' },
			{ name: 'helikon', url: 'wss://rpc.helikon.io/hydradx' },
			{ name: 'dotters', url: 'wss://hydration.dotters.network' },
			{ name: 'ibp', url: 'wss://hydration.ibp.network' },
			{ name: 'parm', url: 'wss://node.parm.hydration.cloud' },
			{ name: 'roach', url: 'wss://rpc.roach.hydration.cloud' },
			{ name: 'zipp', url: 'wss://rpc.zipp.hydration.cloud' },
			{ name: 'sin', url: 'wss://rpc.sin.hydration.cloud' },
			{ name: 'coke', url: 'wss://rpc.coke.hydration.cloud' },
			{ name: 'lait', url: 'wss://rpc.lait.hydration.cloud' },
			{ name: 'stkd', url: 'wss://hydration.rpc.stkd.io' },
		],
		knownAuthors: {},
	},
	{
		name: 'assethub',
		consensus: 'aura',
		nodes: [
			{ name: 'parity-rpc', url: 'wss://polkadot-asset-hub-rpc.polkadot.io' },
			{ name: 'dwellir', url: 'wss://asset-hub-polkadot-rpc.dwellir.com' },
			{ name: 'ibp', url: 'wss://sys.ibp.network/asset-hub-polkadot' },
		],
		knownAuthors: {},
	},
	{
		name: 'moonbeam',
		consensus: 'aura',
		nodes: [
			{ name: 'moonbeam-foundation', url: 'wss://wss.api.moonbeam.network' },
			{ name: 'dwellir', url: 'wss://moonbeam-rpc.dwellir.com' },
			{ name: 'dotters', url: 'wss://moonbeam.dotters.network' },
			{ name: 'ibp', url: 'wss://moonbeam.ibp.network' },
		],
		knownAuthors: {},
	},
];

export const chains = process.env.CHAINS ? JSON.parse(process.env.CHAINS) : defaultChains;
