import { beforeEach, describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';
import { indexRange, indexVaultOnce, runIndexer } from '../../src/indexer/indexer.js';
import { V1_TOPICS, V2_TOPICS } from '../../src/indexer/events.js';
import type { Hex } from '../../src/types.js';
import { FakeChain } from '../helpers/fakeChain.js';
import { createMemoryRepo } from '../helpers/memoryRepo.js';
import { fixedOracle, id, LLTV_915, oracleAddr, scenario, USDE, V1_VAULT, v1Scenario, VAULT } from '../helpers/vaultScenario.js';

const registry = loadRegistry('registry');
const silent = { info() {}, error() {} };
const cfg = { vaults: [VAULT], confirmations: 20, backfillDays: 1, windowSeconds: 600 };
const hashV = (tag: string) => (n: bigint) => `0x${tag}${n.toString(16).padStart(62, '0')}` as Hex;
const log = (address: typeof VAULT, block: number, i = 0) => ({ address, blockNumber: BigInt(block), txHash: `0x${block.toString(16).padStart(64, '0')}` as Hex, logIndex: i });

function chain(head = 1000n) {
  const c = scenario(1_000_000n, [{ n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 700_000n }]);
  fixedOracle(c, oracleAddr(2));
  c.head = head;
  c.hashOf = hashV('aa');
  c.timestampOf = (n) => 1_700_000_000 + Number(n) * 2; // Base: 2 s blocks
  return c;
}
const deps = (c: FakeChain) => {
  const mem = createMemoryRepo();
  return { ...mem, deps: { reader: c, repo: mem.repo, registry, log: silent } };
};

describe('indexRange', () => {
  it('writes one snapshot per event block and is idempotent', async () => {
    const c = chain();
    c.logsList = [log(VAULT, 300), log(VAULT, 400), log(VAULT, 500)];
    const { deps: d, snapshots } = deps(c);
    await indexRange(d, VAULT, 200n, 600n, 1); // window of 1 s: nothing is merged
    expect(snapshots.map((s) => s.block)).toEqual([300n, 400n, 500n]);
    await indexRange(d, VAULT, 200n, 600n, 1);
    expect(snapshots).toHaveLength(3);
  });

  it('coalesces events that fall in the same window', async () => {
    const c = chain();
    c.logsList = [log(VAULT, 300), log(VAULT, 301), log(VAULT, 302), log(VAULT, 500)];
    const { deps: d, snapshots } = deps(c);
    await indexRange(d, VAULT, 200n, 600n, 600); // 600 s = 300 blocks
    // 301 and 302 are 2-4 s after 300 (same window): dropped. 500 is the last of the range: kept.
    expect(snapshots.map((s) => s.block)).toEqual([300n, 500n]);
  });

  it('reads block headers only for the blocks it keeps, not for every event', async () => {
    const c = chain();
    c.logsList = Array.from({ length: 40 }, (_, i) => log(VAULT, 300 + i)).concat(log(VAULT, 500));
    let headers = 0;
    const real = c.block.bind(c);
    c.block = async (n) => { headers++; return real(n); };
    const { deps: d, snapshots } = deps(c);
    await indexRange(d, VAULT, 200n, 600n, 600);
    expect(snapshots.map((s) => s.block)).toEqual([300n, 500n]);
    expect(headers).toBe(2); // one per snapshot, none for the 39 coalesced events
  });

  it('stores the market assumption with each snapshot', async () => {
    const c = chain();
    c.logsList = [log(VAULT, 300)];
    const { deps: d, snapshots, markets } = deps(c);
    await indexRange(d, VAULT, 200n, 600n);
    expect(markets.get(id(1))).toEqual({ id: id(1), assumptionId: 'usde:usd', assumption: 'USDe = 1 USD' });
    expect(snapshots[0]).toMatchObject({ block: 300n, totalAssets: 1_000_000n, positions: [{ marketId: id(1), assets: 700_000n }] });
  });

  it('reads getLogs in chunks of at most 10,000 blocks', async () => {
    const c = chain(100_000n);
    const { deps: d } = deps(c);
    await indexRange(d, VAULT, 1n, 25_000n);
    const v2 = c.logCalls.filter((l) => l.addresses.includes(VAULT));
    expect(v2.map((l) => [l.from, l.to])).toEqual([[1n, 10_000n], [10_001n, 20_000n], [20_001n, 25_000n]]);
    expect(v2.every((l) => JSON.stringify(l.topics0) === JSON.stringify(V2_TOPICS))).toBe(true);
  });

  it('V1 vault events (ERC4626 Deposit/Withdraw) trigger snapshots of the V2 vault', async () => {
    const c = v1Scenario(1_000_000n);
    c.head = 1000n; c.hashOf = hashV('aa'); c.timestampOf = (n) => 1_700_000_000 + Number(n) * 2;
    c.logsList = [log(V1_VAULT, 350)];
    const { deps: d, snapshots } = deps(c);
    await indexRange(d, VAULT, 300n, 400n);
    expect(snapshots.map((s) => s.block)).toEqual([350n]);
    expect(c.logCalls.some((l) => l.addresses.length === 1 && l.addresses[0]!.toLowerCase() === V1_VAULT.toLowerCase() && JSON.stringify(l.topics0) === JSON.stringify(V1_TOPICS))).toBe(true);
  });
});

describe('indexVaultOnce', () => {
  let c: FakeChain;
  beforeEach(() => { c = chain(1000n); });

  it('first run: snapshot at the start block, then events up to head − confirmations only', async () => {
    c.logsList = [log(VAULT, 900), log(VAULT, 995)]; // 995 > 1000 − 20: not final yet
    const { deps: d, snapshots, checkpoints } = deps(c);
    const r = await indexVaultOnce(d, cfg, VAULT);
    // backfill window (1 day = 43,200 blocks) reaches before block 0 on this tiny chain: start at 0
    expect(snapshots.map((s) => s.block)).toEqual([0n, 900n]);
    expect(r).toMatchObject({ to: 980n });
    expect(checkpoints.get(VAULT)).toEqual({ block: 980n, hash: hashV('aa')(980n) });
  });

  it('resumes from the checkpoint without re-reading earlier blocks', async () => {
    c.logsList = [log(VAULT, 900)];
    const { deps: d, snapshots } = deps(c);
    await indexVaultOnce(d, cfg, VAULT);
    c.logCalls.length = 0;
    c.head = 1100n;
    c.logsList.push(log(VAULT, 1050));
    await indexVaultOnce(d, cfg, VAULT);
    expect(Math.min(...c.logCalls.map((l) => Number(l.from)))).toBe(981);
    expect(snapshots.map((s) => s.block)).toContain(1050n);
    expect(snapshots.filter((s) => s.block === 900n)).toHaveLength(1);
  });

  it('does nothing when there is no new final block', async () => {
    const { deps: d, snapshots } = deps(c);
    await indexVaultOnce(d, cfg, VAULT);
    const n = snapshots.length;
    const r = await indexVaultOnce(d, cfg, VAULT);
    expect(r.snapshots).toBe(0);
    expect(snapshots).toHaveLength(n);
  });

  it('rolls back to the last matching block hash after a reorg and re-indexes from there', async () => {
    c.logsList = [log(VAULT, 900), log(VAULT, 950)];
    const { deps: d, snapshots, checkpoints } = deps(c);
    await indexVaultOnce(d, cfg, VAULT);
    const oldHash950 = snapshots.find((s) => s.block === 950n)!.blockHash;
    // blocks from 940 on are replaced by a different fork
    const forked = hashV('bb');
    c.hashOf = (n) => (n >= 940n ? forked(n) : hashV('aa')(n));
    c.head = 1010n;
    c.logCalls.length = 0;
    const r = await indexVaultOnce(d, cfg, VAULT);
    expect(r.rolledBackTo).toBe(900n);
    expect(Math.min(...c.logCalls.map((l) => Number(l.from)))).toBe(901);
    const s950 = snapshots.find((s) => s.block === 950n)!;
    expect(s950.blockHash).toBe(forked(950n));
    expect(s950.blockHash).not.toBe(oldHash950);
    expect(snapshots.find((s) => s.block === 900n)!.blockHash).toBe(hashV('aa')(900n));
    expect(checkpoints.get(VAULT)).toEqual({ block: 990n, hash: forked(990n) });
  });

  it('with no matching hash at all, drops every snapshot and backfills again', async () => {
    c.logsList = [log(VAULT, 900)];
    const { deps: d, snapshots } = deps(c);
    await indexVaultOnce(d, cfg, VAULT);
    c.hashOf = hashV('cc'); // every stored hash is now wrong
    c.head = 1010n;
    const r = await indexVaultOnce(d, cfg, VAULT);
    expect(r.rolledBackTo).toBeNull();
    expect(snapshots.every((s) => s.blockHash.startsWith('0xcc'))).toBe(true);
    expect(snapshots.map((s) => s.block)).toContain(900n);
  });
});

describe('runIndexer', () => {
  it('runs passes until aborted and resolves', async () => {
    const c = chain(1000n);
    const { deps: d, checkpoints } = deps(c);
    const ac = new AbortController();
    const done = runIndexer(d, { ...cfg, pollSeconds: 0.01 }, ac.signal);
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await done;
    expect(checkpoints.get(VAULT)).toBeDefined();
  });

  it('logs a failed pass and keeps going', async () => {
    const c = chain(1000n);
    let calls = 0;
    const real = c.blockNumber.bind(c);
    c.blockNumber = async () => { calls++; if (calls === 1) throw new Error('rpc down'); return real(); };
    const errors: string[] = [];
    const { deps: d, checkpoints } = deps(c);
    const ac = new AbortController();
    const done = runIndexer({ ...d, log: { info() {}, error: (m) => errors.push(m) } }, { ...cfg, pollSeconds: 0.01 }, ac.signal);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    await done;
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints.get(VAULT)).toBeDefined(); // a later pass succeeded
  });
});
