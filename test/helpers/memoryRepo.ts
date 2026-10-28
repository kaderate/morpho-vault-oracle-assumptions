import type { Address, Hex } from '../../src/types.js';
import type { MarketRow, Repo, SnapshotInput } from '../../src/db/repo.js';

// In-memory Repo with the same observable rules as the Postgres one (idempotent inserts, checkpoints, rollback).
export function createMemoryRepo() {
  const snapshots: SnapshotInput[] = [];
  const checkpoints = new Map<Address, { block: bigint; hash: Hex }>();
  const markets = new Map<Hex, MarketRow>();
  const repo: Repo = {
    async upsertMarket(m) { markets.set(m.id, m); },
    async insertSnapshot(s) {
      if (!snapshots.some((x) => x.vault === s.vault && x.block === s.block)) snapshots.push(s);
    },
    async latestSnapshot(vault) {
      const s = snapshots.filter((x) => x.vault === vault).sort((a, b) => (a.block > b.block ? -1 : 1))[0];
      return s ? { block: s.block, ts: s.ts } : null;
    },
    async getCheckpoint(vault) { return checkpoints.get(vault) ?? null; },
    async setCheckpoint(vault, block, hash) { checkpoints.set(vault, { block, hash }); },
    async snapshotHashes(vault, limit) {
      return snapshots.filter((s) => s.vault === vault).sort((a, b) => (a.block > b.block ? -1 : 1))
        .slice(0, limit).map((s) => ({ block: s.block, blockHash: s.blockHash }));
    },
    async deleteSnapshotsAfter(vault, block) {
      for (let i = snapshots.length - 1; i >= 0; i--) if (snapshots[i]!.vault === vault && snapshots[i]!.block > block) snapshots.splice(i, 1);
    },
    async peaks() { throw new Error('peaks is only tested against Postgres'); },
  };
  return { repo, snapshots, checkpoints, markets };
}
