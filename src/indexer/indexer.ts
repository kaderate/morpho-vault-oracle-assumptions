import { analyzeVault } from '../report.js';
import type { Registry } from '../analysis/registry.js';
import { resolveV1Vaults } from '../chain/vaultReader.js';
import type { Repo } from '../db/repo.js';
import type { Address, ChainReader, Hex } from '../types.js';
import { coalesceBlocks, V1_TOPICS, V2_TOPICS } from './events.js';

export interface Logger {
  info(msg: string, ctx?: object): void;
  error(msg: string, ctx?: object): void;
}
export interface IndexerDeps { reader: ChainReader; repo: Repo; registry: Registry; log?: Logger }
export interface IndexerConfig {
  vaults: Address[];
  confirmations: number;
  backfillDays: number;
  pollSeconds?: number; // default 30
  windowSeconds?: number; // default 600: at most one snapshot per vault per 10 minutes
}

const GETLOGS_MAX_BLOCKS = 10_000n; // Infura free tier
const SNAPSHOT_CONCURRENCY = 4;
const BLOCK_SECONDS = 2; // Base
const BLOCKS_PER_DAY = 43_200n;
const consoleLog: Logger = {
  info: (m, c) => console.log(m, c ?? ''),
  error: (m, c) => console.error(m, c ?? ''),
};

// Reads the vault at `block` and stores the snapshot: its positions, and the assumption each market rests on.
async function snapshotAt(deps: IndexerDeps, vault: Address, block: bigint): Promise<void> {
  const a = await analyzeVault(deps, vault, block);
  for (const m of a.markets) {
    const d = m.assumption;
    await deps.repo.upsertMarket({
      id: m.market.id,
      assumptionId: d.kind === 'assumption' ? d.id : null,
      assumption: d.kind === 'assumption' ? d.text : null,
    });
  }
  await deps.repo.insertSnapshot({
    vault,
    block,
    blockHash: a.header.hash,
    ts: new Date(a.header.timestamp * 1000),
    totalAssets: a.totalAssets,
    positions: a.markets.map((m) => ({ marketId: m.market.id, assets: m.assets })),
  });
}

// Snapshots the vault at every (coalesced) block in [from, to] where one of its events fired.
// Safe to run twice on the same range: a snapshot is unique per (vault, block).
export async function indexRange(
  deps: IndexerDeps,
  vault: Address,
  from: bigint,
  to: bigint,
  windowSeconds = 600,
): Promise<{ snapshots: number }> {
  if (from > to) return { snapshots: 0 };
  const { reader } = deps;
  const v1 = await resolveV1Vaults(reader, vault, to);

  const eventBlocks = new Set<bigint>();
  for (let a = from; a <= to; a += GETLOGS_MAX_BLOCKS) {
    const b = a + GETLOGS_MAX_BLOCKS - 1n < to ? a + GETLOGS_MAX_BLOCKS - 1n : to;
    for (const l of await reader.logs({ addresses: [vault], topics0: V2_TOPICS, from: a, to: b })) eventBlocks.add(l.blockNumber);
    if (v1.length > 0) {
      for (const l of await reader.logs({ addresses: v1, topics0: V1_TOPICS, from: a, to: b })) eventBlocks.add(l.blockNumber);
    }
  }

  // Base makes a block every 2 s, so block number × 2 is a timestamp good enough to window events
  // without one getBlock per event (hundreds per day).
  const kept = coalesceBlocks([...eventBlocks].map((n) => ({ number: n, timestamp: Number(n) * BLOCK_SECONDS })), windowSeconds);
  // A few snapshots at once: each one is a chain of dependent reads, so concurrency (bounded by the
  // reader's own request limit) hides the latency and lets Multicall3 merge their calls.
  for (let i = 0; i < kept.length; i += SNAPSHOT_CONCURRENCY) {
    await Promise.all(kept.slice(i, i + SNAPSHOT_CONCURRENCY).map((block) => snapshotAt(deps, vault, block)));
  }
  return { snapshots: kept.length };
}

// Walks stored snapshot hashes newest first and returns the first one the chain still agrees with.
async function lastMatching(deps: IndexerDeps, vault: Address): Promise<{ block: bigint; blockHash: Hex } | null> {
  for (const h of await deps.repo.snapshotHashes(vault, 200)) {
    if ((await deps.reader.block(h.block)).hash === h.blockHash) return h;
  }
  return null;
}

export interface PassResult { from: bigint; to: bigint; snapshots: number; rolledBackTo?: bigint | null }

// One pass for one vault: detect a reorg, index up to head − confirmations, move the checkpoint.
// Snapshots are written before the checkpoint moves: a crash in between only repeats idempotent work.
export async function indexVaultOnce(deps: IndexerDeps, cfg: IndexerConfig, vault: Address): Promise<PassResult> {
  const { reader, repo } = deps;
  const windowSeconds = cfg.windowSeconds ?? 600;
  const head = await reader.blockNumber();
  const safe = head - BigInt(cfg.confirmations);
  let cp = await repo.getCheckpoint(vault);
  let rolledBackTo: bigint | null | undefined;

  if (cp && (await reader.block(cp.block)).hash !== cp.hash) {
    const match = await lastMatching(deps, vault);
    deps.log?.error('reorg detected, rolling back', { vault, checkpoint: cp.block, rolledBackTo: match?.block ?? null });
    await repo.deleteSnapshotsAfter(vault, match ? match.block : -1n);
    rolledBackTo = match ? match.block : null;
    cp = match ? { block: match.block, hash: match.blockHash } : null;
    if (cp) await repo.setCheckpoint(vault, cp.block, cp.hash);
  }

  let snapshots = 0;
  let from: bigint;
  if (cp) {
    from = cp.block + 1n;
  } else {
    // first run: backfill window, with a first snapshot at its start
    const start = safe - BigInt(cfg.backfillDays) * BLOCKS_PER_DAY;
    const startBlock = start < 0n ? 0n : start;
    if (startBlock > safe) return { from: startBlock, to: safe, snapshots: 0 };
    await snapshotAt(deps, vault, startBlock);
    snapshots++;
    from = startBlock + 1n;
  }
  if (from > safe) return { from, to: safe, snapshots, ...(rolledBackTo !== undefined ? { rolledBackTo } : {}) };

  snapshots += (await indexRange(deps, vault, from, safe, windowSeconds)).snapshots;
  await repo.setCheckpoint(vault, safe, (await reader.block(safe)).hash);
  return { from, to: safe, snapshots, ...(rolledBackTo !== undefined ? { rolledBackTo } : {}) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Runs passes forever (until aborted). A failed pass is logged and retried on the next tick: the RPC is
// expected to fail now and then, and the checkpoint only moves after a pass has fully succeeded.
export async function runIndexer(deps: IndexerDeps, cfg: IndexerConfig, signal: AbortSignal): Promise<void> {
  const log = deps.log ?? consoleLog;
  const d = { ...deps, log };
  while (!signal.aborted) {
    for (const vault of cfg.vaults) {
      if (signal.aborted) break;
      try {
        const r = await indexVaultOnce(d, cfg, vault);
        if (r.snapshots > 0) log.info('indexed', { vault, from: r.from, to: r.to, snapshots: r.snapshots });
      } catch (e) {
        log.error('indexer pass failed', { vault, error: (e as Error).message });
      }
    }
    await sleep((cfg.pollSeconds ?? 30) * 1000, signal);
  }
}
