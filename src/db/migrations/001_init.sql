-- Markets are immutable on Morpho Blue: one row per market, written once.
CREATE TABLE markets (
  id            TEXT PRIMARY KEY,
  collateral    TEXT NOT NULL,
  oracle        TEXT NOT NULL,
  lltv          NUMERIC(40, 0) NOT NULL,
  assumption_id TEXT,            -- NULL when the market is `none` or `unknown`
  assumption    TEXT,
  oracle_class  TEXT NOT NULL
);

-- One row per (vault, block) where an allocation event happened. block_hash lets the indexer detect a reorg.
CREATE TABLE snapshots (
  id           BIGSERIAL PRIMARY KEY,
  vault        TEXT NOT NULL,
  block        BIGINT NOT NULL,
  block_hash   TEXT NOT NULL,
  ts           TIMESTAMPTZ NOT NULL,
  total_assets NUMERIC(78, 0) NOT NULL,
  UNIQUE (vault, block)
);
CREATE INDEX snapshots_vault_ts ON snapshots (vault, ts);

CREATE TABLE snapshot_positions (
  snapshot_id BIGINT NOT NULL REFERENCES snapshots (id) ON DELETE CASCADE,
  market_id   TEXT NOT NULL REFERENCES markets (id),
  assets      NUMERIC(78, 0) NOT NULL,
  meta_state  JSONB,             -- MetaOracle state at this block, when the market has one
  PRIMARY KEY (snapshot_id, market_id)
);

-- Last block fully indexed per vault, and its hash.
CREATE TABLE checkpoints (
  vault      TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  last_hash  TEXT NOT NULL
);
