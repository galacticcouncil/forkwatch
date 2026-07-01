CREATE TABLE IF NOT EXISTS fork_blocks (
	id              BIGSERIAL PRIMARY KEY,
	chain           TEXT NOT NULL,
	block_number    BIGINT NOT NULL,
	block_hash      TEXT NOT NULL UNIQUE,
	parent_hash     TEXT NOT NULL,
	state_root      TEXT,
	extrinsics_root TEXT,
	author          TEXT,
	author_name     TEXT,
	relay_parent    TEXT,
	relay_number    BIGINT,
	seen_by         TEXT[],
	imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE fork_blocks ADD COLUMN IF NOT EXISTS state_root TEXT;
ALTER TABLE fork_blocks ADD COLUMN IF NOT EXISTS extrinsics_root TEXT;
ALTER TABLE fork_blocks ADD COLUMN IF NOT EXISTS relay_number BIGINT;

CREATE INDEX IF NOT EXISTS idx_fork_blocks_chain_number ON fork_blocks (chain, block_number);
CREATE INDEX IF NOT EXISTS idx_fork_blocks_author ON fork_blocks (chain, author);

CREATE TABLE IF NOT EXISTS fork_events (
	id              BIGSERIAL PRIMARY KEY,
	chain           TEXT NOT NULL,
	block_number    BIGINT NOT NULL,
	competing_count INT NOT NULL,
	authors         TEXT[],
	cause           TEXT,
	relay_height    BIGINT,
	depth           INT NOT NULL DEFAULT 1,
	same_author     BOOLEAN,
	same_relay      BOOLEAN,
	same_parent     BOOLEAN,
	details         JSONB,
	resolved        BOOLEAN DEFAULT FALSE,
	resolved_hash   TEXT,
	detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	resolved_at     TIMESTAMPTZ
);

ALTER TABLE fork_events ADD COLUMN IF NOT EXISTS same_author BOOLEAN;
ALTER TABLE fork_events ADD COLUMN IF NOT EXISTS same_relay BOOLEAN;
ALTER TABLE fork_events ADD COLUMN IF NOT EXISTS same_parent BOOLEAN;
ALTER TABLE fork_events ADD COLUMN IF NOT EXISTS details JSONB;

CREATE INDEX IF NOT EXISTS idx_fork_events_chain ON fork_events (chain, detected_at);
CREATE INDEX IF NOT EXISTS idx_fork_events_cause ON fork_events (chain, cause);
CREATE INDEX IF NOT EXISTS idx_fork_events_author ON fork_events USING GIN (authors);

CREATE TABLE IF NOT EXISTS finality_log (
	id               BIGSERIAL PRIMARY KEY,
	chain            TEXT NOT NULL,
	node             TEXT NOT NULL,
	best_height      BIGINT NOT NULL,
	finalized_height BIGINT NOT NULL,
	lag              INT NOT NULL,
	recorded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_finality_log_chain ON finality_log (chain, recorded_at);
