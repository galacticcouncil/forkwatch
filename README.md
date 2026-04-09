# forkwatch

fork monitoring service for substrate-based chains. tracks forks in real-time across multiple chains, attributes them to block authors, and determines whether parachain forks were caused by relay chain forks or collator contention.

## architecture

```
                          ┌────────────────────────────────────────────┐
                          │              forkwatch                     │
                          │                                            │
 ┌──────────┐  wss://     │  ┌────────────┐    ┌──────────────────┐    │
 │ polkadot ├────────────►│  │            │    │   fork detector  │    │
 │  (babe)  │  allHeads   │  │            │    │                  │    │
 └──────────┘  newHeads   │  │            ├───►│  block tree      │    │
               finalized  │  │  chain     │    │  depth tracking  │    │
                          │  │  manager   │    │  author metrics  │    │
 ┌──────────┐  wss://     │  │            │    └────────┬─────────┘    │
 │hydration ├────────────►│  │            │             │              │
 │  (aura)  │             │  │            │    ┌────────▼─────────┐    │
 └──────────┘             │  │            │    │    causation     │    │
                          │  │            │    │                  │    │
 ┌──────────┐  wss://     │  │            │    │  relay parent    │    │
 │ assethub ├────────────►│  │            │    │  comparison      │    │
 │  (aura)  │             │  │            │    │                  │    │
 └──────────┘             │  │            │    │  relay_fork vs   │    │
                          │  │            │    │  collator_       │    │
 ┌──────────┐  wss://     │  │            │    │  contention      │    │
 │ moonbeam ├────────────►│  │            │    └──────────────────┘    │
 │  (aura)  │             │  └────────────┘                            │
 └──────────┘             │                                            │
                          │  ┌────────────┐    ┌──────────────────┐    │
                          │  │ prometheus │    │    identity      │    │
                          │  │  metrics   │◄───┤    resolver      │    │
                          │  │  :3001     │    │                  │    │
                          │  └─────┬──────┘    │  on-chain names  │    │
                          │        │           │  via IdentityOf  │    │
                          └────────┼───────────┴──────────────────┘    │
                                   │                                   │
                          ┌────────┼────────────────────────────┐      │
                          │        │           optional         │      │
                          │  ┌─────▼──────┐                     │      │
                          │  │  grafana   │    ┌──────────────┐ │      │
                          │  │            ├───►│  postgresql  │◄┼──────┘
                          │  │ dashboards │    │  fork events │ │
                          │  └────────────┘    │  block logs  │ │
                          │                    │  finality    │ │
                          │                    └──────────────┘ │
                          └─────────────────────────────────────┘
```

## how it works

each substrate node exposes `chain_subscribeAllHeads` which delivers every imported block, including fork branches. when two blocks appear at the same height with different hashes, that's a fork.

for parachain forks, forkwatch compares the relay parent reference in each competing block:
- **different relay parents** → `relay_fork` (the relay chain forked, parachain followed)
- **same relay parent** → `collator_contention` (multiple collators produced competing blocks)

block authors are resolved from the consensus digest (aura/babe) and enriched with on-chain identity names via `identity.identityOf` / `identity.superOf`, cached permanently.

## quick start

```sh
# run locally (no database required)
npm install
node src/index.js

# with docker
docker compose up
```

by default it connects to polkadot, hydration, assethub, and moonbeam using public rpcs. override with the `CHAINS` env variable.

## configuration

| env variable | default | description |
|---|---|---|
| `CHAINS` | polkadot + hydration + assethub + moonbeam | json array of chain configs |
| `DATABASE_URL` | _(none)_ | postgresql connection string, omit to run without db |
| `PORT` | 3001 | http server port |
| `TIMEOUT` | 120 | seconds without a block before reconnecting a node |
| `PRUNE_FINALIZED_AFTER` | 50 | blocks behind finalized to keep in memory |
| `RETENTION_DAYS` | 90 | days to keep fork_blocks and finality_log in db |
| `FORK_EVENT_RETENTION_DAYS` | 365 | days to keep fork_events in db |
| `FINALITY_LOG_INTERVAL` | 60 | seconds between finality log samples |

### chain config format

```json
[
  {
    "name": "hydration",
    "consensus": "aura",
    "nodes": [
      { "name": "gc", "url": "wss://rpc.hydradx.cloud" },
      { "name": "dwellir", "url": "wss://hydration-rpc.n.dwellir.com" }
    ],
    "knownAuthors": { "5Grw...": "alice" }
  }
]
```

- `consensus`: `aura` for parachains, `babe` for relay chains (informational, polkadot.js handles both)
- `knownAuthors`: optional manual name overrides, on-chain identity is resolved automatically
- causation attribution is enabled automatically when both a relay chain (babe) and parachains (aura) are configured

## api

```
GET /metrics                     prometheus scrape endpoint
GET /api/status                  chain states, node connections, heights
GET /api/forks?limit=100         recent fork events across all chains
GET /api/forks/:chain            fork events for a specific chain
GET /api/blocks/:chain/:height   competing blocks at a forked height
GET /api/health                  liveness probe
```

## prometheus metrics

all prefixed `forkwatch_`:

| metric | type | labels | description |
|---|---|---|---|
| `fork_events_total` | counter | chain | fork occurrences |
| `fork_depth` | histogram | chain | fork depth distribution |
| `active_fork_heights` | gauge | chain | currently unresolved forks |
| `author_fork_blocks_total` | counter | chain, author | forked blocks per author |
| `author_blocks_total` | counter | chain, author | total blocks per author |
| `best_block_height` | gauge | chain, node | unfinalized head |
| `finalized_block_height` | gauge | chain, node | finalized head |
| `finality_lag_blocks` | gauge | chain, node | best - finalized gap |
| `node_connected` | gauge | chain, node | connection health (0/1) |
| `blocks_imported_total` | counter | chain, node | blocks seen per node |
| `parachain_fork_cause_total` | counter | chain, cause | forks by cause |
| `parachain_forks_relay_caused_total` | counter | chain, relay_chain | relay-attributed forks |

## database (optional)

set `DATABASE_URL` to enable postgresql storage. schema is auto-created on startup.

three tables:
- **fork_blocks** — every block at forked heights (hash, author, relay parent, seen by which nodes)
- **fork_events** — one row per fork (competing count, cause, depth, resolved hash)
- **finality_log** — periodic finality lag snapshots for long-term analysis

grafana can query both prometheus and postgresql as data sources.

## deployment

swarm-compatible stack file included:

```sh
docker stack deploy -c docker-compose.yml forkwatch
```

image: `galacticcouncil/forkwatch:latest`

the service is exposed via traefik at `https://forkwatch.play.hydration.cloud`. endpoints:
- `https://forkwatch.play.hydration.cloud/metrics` — prometheus scrape
- `https://forkwatch.play.hydration.cloud/api/status` — service status
- `https://forkwatch.play.hydration.cloud/api/forks` — recent fork events

### prometheus configuration

add the following scrape config to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'forkwatch'
    scrape_interval: 15s
    static_configs:
      - targets: ['forkwatch.play.hydration.cloud']
    scheme: https
```

or if prometheus runs inside the same swarm network, scrape the service directly without tls:

```yaml
scrape_configs:
  - job_name: 'forkwatch'
    scrape_interval: 15s
    static_configs:
      - targets: ['app:3001']
    # use the swarm service name and internal port
```

### grafana

add two data sources:
1. **prometheus** — query `forkwatch_*` metrics for real-time dashboards
2. **postgresql** — connect to `forkwatch-db:5432` (db: `forkwatch`, user: `forkwatch`) for detailed fork event queries

## resilience

- all chains and nodes connect in parallel
- a failed node doesn't affect other nodes or chains
- per-node watchdog reconnects silently after timeout (no process restart)
- WsProvider handles transient websocket disconnects automatically
- database is optional — service runs fine without it (console + prometheus only)

## tests

```sh
npm test
```

53 tests across 4 suites: block-tree, fork-detector, causation, queries.

## project structure

```
src/
  index.js              entrypoint, metric registration, api routes
  config.js             dotenv config with default chain list
  metrics.js            prom-client MetricsRegistry
  endpoints.js          express EndpointRegistry
  db/
    schema.sql          postgresql table definitions
    index.js            connection pool with retry
    queries.js          insert/query/cleanup (no-op when db disabled)
  chain/
    connection.js       WsProvider + ApiPromise per node with timeout
    manager.js          multi-chain lifecycle, subscriptions, reconnection
  monitor/
    block-tree.js       in-memory block tree (~100KB, pruned on finalization)
    fork-detector.js    fork detection, metrics, db logging
    author-extractor.js aura/babe author + on-chain identity resolution
    causation.js        relay parent comparison for fork cause attribution
    finality-tracker.js best/finalized lag tracking with periodic db sampling
```

## license

Apache-2.0
