-- One row per market the vaults hold: which assumption its oracle rests on (NULL when `none` or `unknown`).
CREATE TABLE markets (
  id            TEXT PRIMARY KEY,
  assumption_id TEXT,
  assumption    TEXT
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
  PRIMARY KEY (snapshot_id, market_id)
);

-- Last block fully indexed per vault, and its hash.
CREATE TABLE checkpoints (
  vault      TEXT PRIMARY KEY,
  last_block BIGINT NOT NULL,
  last_hash  TEXT NOT NULL
);
