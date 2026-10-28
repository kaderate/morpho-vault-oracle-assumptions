import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, migrate } from '../../src/db/pool.js';
import { createRepo, type Repo } from '../../src/db/repo.js';
import type { Address, Hex } from '../../src/types.js';

const URL = process.env.DATABASE_URL;
const VAULT: Address = '0x00000000000000000000000000000000000000a1';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const mid = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const NOW = new Date('2026-10-28T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const BIG = 463_354_112_123_456_789_012n; // far above 2^53

describe.skipIf(!URL)('repo (Postgres)', () => {
  const schema = `test_${Math.random().toString(36).slice(2, 10)}`;
  let admin: pg.Pool, pool: pg.Pool, repo: Repo;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: URL });
    await admin.query(`CREATE SCHEMA ${schema}`); // isolated: never touches the dev data
    pool = createPool(URL as string, schema);
    await migrate(pool);
    repo = createRepo(pool);
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE snapshot_positions, snapshots, markets, checkpoints CASCADE');
    await repo.upsertMarket({ id: mid(1), collateral: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', oracle: '0x0000000000000000000000000000000000000f01', lltv: 915000000000000000n, assumptionId: 'usde:usd', assumption: 'USDe = 1 USD', oracleClass: 'metaoracle' });
    await repo.upsertMarket({ id: mid(2), collateral: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', oracle: '0x0000000000000000000000000000000000000f02', lltv: 860000000000000000n, assumptionId: 'cbbtc:btc', assumption: 'cbBTC = BTC', oracleClass: 'chainlink' });
  });

  const snap = (block: number, ts: Date, usde: bigint, btc: bigint, total = 1000n) => ({
    vault: VAULT, block: BigInt(block), blockHash: hash(block), ts, totalAssets: total,
    positions: [{ marketId: mid(1), assets: usde }, { marketId: mid(2), assets: btc }].filter((p) => p.assets > 0n),
  });

  it('migrating twice is harmless', async () => {
    await migrate(pool);
  });

  it('inserting the same (vault, block) twice leaves one row', async () => {
    await repo.insertSnapshot(snap(10, hoursAgo(5), 500n, 100n));
    await repo.insertSnapshot(snap(10, hoursAgo(5), 500n, 100n));
    const { rows } = await pool.query('SELECT (SELECT count(*) FROM snapshots) s, (SELECT count(*) FROM snapshot_positions) p');
    expect(rows[0]).toEqual({ s: '1', p: '2' });
  });

  it('peaks returns the max share, its block, the current share and the coverage', async () => {
    await repo.insertSnapshot(snap(10, hoursAgo(72), 200n, 700n));
    await repo.insertSnapshot(snap(20, hoursAgo(48), 810n, 100n)); // peak: 81%
    await repo.insertSnapshot(snap(30, hoursAgo(1), 763n, 100n)); // current: 76.3%
    const r = await repo.peaks(VAULT, 30, NOW);
    expect(r.coverage).toEqual({ from: hoursAgo(72), snapshots: 3, windowComplete: false });
    const usde = r.peaks.find((p) => p.assumptionId === 'usde:usd')!;
    expect(usde).toMatchObject({ assumption: 'USDe = 1 USD', currentSharePct: 76.3, peakSharePct: 81, peakBlock: 20n });
    expect(usde.peakAt).toEqual(hoursAgo(48));
  });

  it('keeps an assumption that is now at 0%', async () => {
    await repo.insertSnapshot(snap(10, hoursAgo(10), 300n, 600n));
    await repo.insertSnapshot(snap(20, hoursAgo(1), 0n, 900n));
    const usde = (await repo.peaks(VAULT, 30, NOW)).peaks.find((p) => p.assumptionId === 'usde:usd')!;
    expect(usde).toMatchObject({ currentSharePct: 0, peakSharePct: 30, peakBlock: 10n });
  });

  it('windowComplete is true once the first snapshot is older than the window', async () => {
    await repo.insertSnapshot(snap(10, hoursAgo(24 * 31), 100n, 100n));
    expect((await repo.peaks(VAULT, 30, NOW)).coverage.windowComplete).toBe(true);
  });

  it('peaks on an empty vault has no coverage', async () => {
    expect(await repo.peaks(VAULT, 30, NOW)).toEqual({ coverage: { from: null, snapshots: 0, windowComplete: false }, peaks: [] });
  });

  it('deleteSnapshotsAfter removes later rows only', async () => {
    for (const b of [10, 20, 30]) await repo.insertSnapshot(snap(b, hoursAgo(40 - b), 100n, 100n));
    await repo.deleteSnapshotsAfter(VAULT, 20n);
    expect((await repo.snapshotHashes(VAULT, 10)).map((h) => h.block)).toEqual([20n, 10n]);
  });

  it('snapshotHashes returns the newest first, limited', async () => {
    for (const b of [10, 20, 30]) await repo.insertSnapshot(snap(b, hoursAgo(40 - b), 100n, 100n));
    expect(await repo.snapshotHashes(VAULT, 2)).toEqual([{ block: 30n, blockHash: hash(30) }, { block: 20n, blockHash: hash(20) }]);
  });

  it('amounts above 2^53 round-trip exactly', async () => {
    await repo.insertSnapshot(snap(10, hoursAgo(1), BIG, 1n, BIG + 1n));
    const s = await repo.latestSnapshot(VAULT);
    expect(s).toMatchObject({ block: 10n, blockHash: hash(10), totalAssets: BIG + 1n });
    expect(s!.positions.find((p) => p.marketId === mid(1))!.assets).toBe(BIG);
  });

  it('checkpoint: none, then set, then overwritten', async () => {
    expect(await repo.getCheckpoint(VAULT)).toBeNull();
    await repo.setCheckpoint(VAULT, 5n, hash(5));
    await repo.setCheckpoint(VAULT, 9n, hash(9));
    expect(await repo.getCheckpoint(VAULT)).toEqual({ block: 9n, hash: hash(9) });
  });

  it('latestSnapshot is null for a vault without snapshots', async () => {
    expect(await repo.latestSnapshot(VAULT)).toBeNull();
  });
});
