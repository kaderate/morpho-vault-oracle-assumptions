import type pg from 'pg';
import type { Address, Hex } from '../types.js';

export interface MarketRow {
  id: Hex;
  collateral: Address;
  oracle: Address;
  lltv: bigint;
  assumptionId: string | null;
  assumption: string | null;
  oracleClass: string;
}
export interface SnapshotInput {
  vault: Address;
  block: bigint;
  blockHash: Hex;
  ts: Date;
  totalAssets: bigint;
  positions: { marketId: Hex; assets: bigint; metaState?: unknown }[];
}
export type StoredSnapshot = SnapshotInput;
export interface PeakResult {
  coverage: { from: Date | null; snapshots: number; windowComplete: boolean };
  peaks: { assumptionId: string; assumption: string; currentSharePct: number; peakSharePct: number; peakBlock: bigint; peakAt: Date }[];
}

export interface Repo {
  upsertMarket(m: MarketRow): Promise<void>;
  insertSnapshot(s: SnapshotInput): Promise<void>;
  latestSnapshot(vault: Address): Promise<StoredSnapshot | null>;
  getCheckpoint(vault: Address): Promise<{ block: bigint; hash: Hex } | null>;
  setCheckpoint(vault: Address, block: bigint, hash: Hex): Promise<void>;
  snapshotHashes(vault: Address, limit: number): Promise<{ block: bigint; blockHash: Hex }[]>;
  deleteSnapshotsAfter(vault: Address, block: bigint): Promise<void>;
  peaks(vault: Address, days: number, now?: Date): Promise<PeakResult>;
}

// Amounts are NUMERIC in Postgres and cross the driver as strings: bigint in, bigint out, never `number`.
export function createRepo(pool: pg.Pool): Repo {
  return {
    async upsertMarket(m) {
      // Markets are immutable: a second write of the same id changes nothing.
      await pool.query(
        `INSERT INTO markets (id, collateral, oracle, lltv, assumption_id, assumption, oracle_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET assumption_id = EXCLUDED.assumption_id, assumption = EXCLUDED.assumption, oracle_class = EXCLUDED.oracle_class`,
        [m.id, m.collateral, m.oracle, m.lltv.toString(), m.assumptionId, m.assumption, m.oracleClass],
      );
    },

    async insertSnapshot(s) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const ins = await client.query<{ id: string }>(
          `INSERT INTO snapshots (vault, block, block_hash, ts, total_assets) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (vault, block) DO NOTHING RETURNING id`,
          [s.vault, s.block.toString(), s.blockHash, s.ts, s.totalAssets.toString()],
        );
        const id = ins.rows[0]?.id;
        if (id !== undefined) {
          for (const p of s.positions) {
            await client.query(
              'INSERT INTO snapshot_positions (snapshot_id, market_id, assets, meta_state) VALUES ($1, $2, $3, $4)',
              [id, p.marketId, p.assets.toString(), p.metaState === undefined ? null : JSON.stringify(p.metaState)],
            );
          }
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },

    async latestSnapshot(vault) {
      const { rows } = await pool.query(
        'SELECT id, block, block_hash, ts, total_assets FROM snapshots WHERE vault = $1 ORDER BY block DESC LIMIT 1',
        [vault],
      );
      const r = rows[0];
      if (!r) return null;
      const pos = await pool.query('SELECT market_id, assets, meta_state FROM snapshot_positions WHERE snapshot_id = $1', [r.id]);
      return {
        vault,
        block: BigInt(r.block),
        blockHash: r.block_hash,
        ts: r.ts,
        totalAssets: BigInt(r.total_assets),
        positions: pos.rows.map((p) => ({ marketId: p.market_id, assets: BigInt(p.assets), ...(p.meta_state ? { metaState: p.meta_state } : {}) })),
      };
    },

    async getCheckpoint(vault) {
      const { rows } = await pool.query('SELECT last_block, last_hash FROM checkpoints WHERE vault = $1', [vault]);
      return rows[0] ? { block: BigInt(rows[0].last_block), hash: rows[0].last_hash } : null;
    },

    async setCheckpoint(vault, block, hash) {
      await pool.query(
        `INSERT INTO checkpoints (vault, last_block, last_hash) VALUES ($1, $2, $3)
         ON CONFLICT (vault) DO UPDATE SET last_block = EXCLUDED.last_block, last_hash = EXCLUDED.last_hash`,
        [vault, block.toString(), hash],
      );
    },

    async snapshotHashes(vault, limit) {
      const { rows } = await pool.query('SELECT block, block_hash FROM snapshots WHERE vault = $1 ORDER BY block DESC LIMIT $2', [vault, limit]);
      return rows.map((r) => ({ block: BigInt(r.block), blockHash: r.block_hash }));
    },

    async deleteSnapshotsAfter(vault, block) {
      await pool.query('DELETE FROM snapshots WHERE vault = $1 AND block > $2', [vault, block.toString()]);
    },

    // Peak share per assumption over the window. A lower bound: snapshots exist at allocation events only.
    async peaks(vault, days, now = new Date()) {
      const since = new Date(now.getTime() - days * 86_400_000);
      const cov = await pool.query(
        `SELECT min(ts) FILTER (WHERE ts >= $2) AS from_ts, count(*) FILTER (WHERE ts >= $2) AS n, min(ts) AS first_ts
         FROM snapshots WHERE vault = $1 AND ts <= $3`,
        [vault, since, now],
      );
      const n = Number(cov.rows[0].n);
      const coverage = {
        from: (cov.rows[0].from_ts as Date | null) ?? null,
        snapshots: n,
        windowComplete: cov.rows[0].first_ts !== null && cov.rows[0].first_ts <= since,
      };
      if (n === 0) return { coverage, peaks: [] };

      // share = assets of the assumption's markets / total_assets, per snapshot, in percent
      const { rows } = await pool.query(
        `WITH shares AS (
           SELECT s.id, s.block, s.ts, m.assumption_id, m.assumption,
                  sum(p.assets) * 100 / NULLIF(s.total_assets, 0) AS pct
           FROM snapshots s
           JOIN snapshot_positions p ON p.snapshot_id = s.id
           JOIN markets m ON m.id = p.market_id
           WHERE s.vault = $1 AND s.ts >= $2 AND s.ts <= $3 AND m.assumption_id IS NOT NULL
           GROUP BY s.id, s.block, s.ts, s.total_assets, m.assumption_id, m.assumption),
         latest AS (SELECT id FROM snapshots WHERE vault = $1 AND ts >= $2 AND ts <= $3 ORDER BY block DESC LIMIT 1),
         peak AS (SELECT DISTINCT ON (assumption_id) assumption_id, assumption, pct, block, ts
                  FROM shares ORDER BY assumption_id, pct DESC, block ASC)
         SELECT peak.assumption_id, peak.assumption, peak.pct AS peak_pct, peak.block AS peak_block, peak.ts AS peak_ts,
                COALESCE((SELECT sh.pct FROM shares sh WHERE sh.id = (SELECT id FROM latest) AND sh.assumption_id = peak.assumption_id), 0) AS current_pct
         FROM peak ORDER BY peak.pct DESC`,
        [vault, since, now],
      );
      return {
        coverage,
        peaks: rows.map((r) => ({
          assumptionId: r.assumption_id,
          assumption: r.assumption,
          currentSharePct: round2(r.current_pct),
          peakSharePct: round2(r.peak_pct),
          peakBlock: BigInt(r.peak_block),
          peakAt: r.peak_ts,
        })),
      };
    },
  };
}

const round2 = (numeric: string | number) => Math.round(Number(numeric) * 100) / 100; // a percentage, not an amount
