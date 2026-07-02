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

CREATE TABLE IF NOT EXISTS submitted_txs (
	id              BIGSERIAL PRIMARY KEY,
	chain           TEXT NOT NULL,
	signer          TEXT, -- null when evm sender recovery failed/wasn't attempted (wrapper-hash-only tracking)
	nonce           BIGINT,
	kind            TEXT NOT NULL DEFAULT 'substrate', -- substrate | evm
	section         TEXT,
	method          TEXT,
	status          TEXT NOT NULL, -- dropped | expired | resubmitted | reorged_lost | reorged_resubmitted | reorged_reincluded
	first_hash      TEXT NOT NULL,
	last_hash       TEXT NOT NULL,
	-- one entry per hash this (signer,nonce) incident cycled through: {hash, birth, death, firstSeenAt, outcome}.
	-- era is per-attempt, not per-incident -- a resubmission gets its own era (that's typically why
	-- the hash changed at all), so a flat birth/death column would misrepresent multi-attempt incidents.
	attempts        JSONB NOT NULL DEFAULT '[]',
	lost_at_height  BIGINT,
	lost_at_hash    TEXT,
	resolved_hash   TEXT,
	resolved_height BIGINT,
	detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	resolved_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_submitted_txs_chain_signer ON submitted_txs (chain, signer);
CREATE INDEX IF NOT EXISTS idx_submitted_txs_status ON submitted_txs (chain, status);
CREATE INDEX IF NOT EXISTS idx_submitted_txs_detected ON submitted_txs (chain, detected_at);

-- audit log for the whitelisted-account auto-resubmission feature. deliberately
-- separate from submitted_txs: since resubmission can fire before an incident
-- is ever classified as dropped/reorged_lost (or fire and succeed, so no
-- submitted_txs row is ever written at all), this needs to exist independently
-- of whether the underlying incident produces a row there.
CREATE TABLE IF NOT EXISTS resubmit_attempts (
	id            BIGSERIAL PRIMARY KEY,
	chain         TEXT NOT NULL,
	signer        TEXT NOT NULL,
	nonce         BIGINT NOT NULL,
	hash          TEXT NOT NULL, -- same before and after -- identical bytes are replayed, no new signature
	trigger       TEXT NOT NULL, -- mempool_drop | reorg_loss
	result        TEXT NOT NULL, -- succeeded | failed
	error         TEXT,
	attempted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_resubmit_attempts_chain_signer ON resubmit_attempts (chain, signer);
CREATE INDEX IF NOT EXISTS idx_resubmit_attempts_attempted ON resubmit_attempts (chain, attempted_at);
