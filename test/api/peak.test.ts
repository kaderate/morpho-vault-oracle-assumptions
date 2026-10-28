import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';
import { buildServer } from '../../src/api/server.js';
import { RpcUnavailableError } from '../../src/chain/errors.js';
import type { PeakResult } from '../../src/db/repo.js';
import { createMemoryRepo } from '../helpers/memoryRepo.js';
import { scenario, VAULT } from '../helpers/vaultScenario.js';

const registry = loadRegistry('registry');
const V = getAddress(VAULT);
const empty: PeakResult = { coverage: { from: null, snapshots: 0, windowComplete: false }, peaks: [] };

// /peak reads the database only: the chain is never needed (the reader throws if it is touched).
function server(peaks: PeakResult | ((vault: string, days: number) => PeakResult), snapshot?: { block: bigint; ts: Date }) {
  const reader = scenario(1n, []);
  reader.latest = async () => { throw new RpcUnavailableError('the chain must not be used by /peak'); };
  const { repo } = createMemoryRepo();
  if (snapshot) void repo.insertSnapshot({ vault: V, block: snapshot.block, blockHash: `0x${'1'.repeat(64)}`, ts: snapshot.ts, totalAssets: 1n, positions: [] });
  const stub = { ...repo, peaks: async (v: string, d: number) => (typeof peaks === 'function' ? peaks(v, d) : peaks) };
  return buildServer({ reader, registry, vaults: [V], repo: stub });
}

describe('GET /vaults/:address/peak', () => {
  it('returns coverage and peaks in the documented shape, as of the latest stored snapshot', async () => {
    let asked: [string, number] | null = null;
    const app = server(
      (vault, days) => {
        asked = [vault, days];
        return {
          coverage: { from: new Date('2026-10-21T00:00:00Z'), snapshots: 14, windowComplete: false },
          peaks: [
            { assumptionId: 'usde:usd', assumption: 'USDe = 1 USD', currentSharePct: 76.3, peakSharePct: 81, peakBlock: 52_800_000n, peakAt: new Date('2026-10-23T08:30:00Z') },
            { assumptionId: 'cbxrp:xrp', assumption: 'cbXRP = XRP', currentSharePct: 0, peakSharePct: 3.5, peakBlock: 52_000_000n, peakAt: new Date('2026-10-22T08:30:00Z') },
          ],
        };
      },
      { block: 53_206_000n, ts: new Date('2026-10-28T12:00:00Z') },
    );
    const res = await app.inject(`/vaults/${V}/peak`);
    expect(res.statusCode).toBe(200);
    expect(asked).toEqual([V, 30]);
    expect(res.json()).toEqual({
      vault: V, block: 53_206_000, asOf: '2026-10-28T12:00:00.000Z', windowDays: 30,
      coverage: { from: '2026-10-21T00:00:00.000Z', snapshots: 14, windowComplete: false },
      peaks: [
        { assumptionId: 'usde:usd', assumption: 'USDe = 1 USD', currentSharePct: 76.3, peakSharePct: 81, peakBlock: 52_800_000, peakAt: '2026-10-23T08:30:00.000Z' },
        { assumptionId: 'cbxrp:xrp', assumption: 'cbXRP = XRP', currentSharePct: 0, peakSharePct: 3.5, peakBlock: 52_000_000, peakAt: '2026-10-22T08:30:00.000Z' },
      ],
    });
  });

  it('works while the RPC is down, and says null/empty when nothing is stored yet', async () => {
    let days = 0;
    const res = await server((_v, d) => { days = d; return empty; }).inject(`/vaults/${V}/peak?days=7`);
    expect(res.statusCode).toBe(200);
    expect(days).toBe(7);
    expect(res.json()).toMatchObject({ block: null, asOf: null, windowDays: 7, coverage: { from: null, snapshots: 0 }, peaks: [] });
  });

  it('400 INVALID_PARAMETER for a bad days value', async () => {
    const app = server(() => { throw new Error('not reached'); });
    for (const d of ['0', '-3', 'abc', '1.5', '500']) {
      const res = await app.inject(`/vaults/${V}/peak?days=${d}`);
      expect(res.statusCode, d).toBe(400);
      expect(res.json().error.code).toBe('INVALID_PARAMETER');
    }
  });

  it('404 VAULT_NOT_TRACKED and 400 INVALID_ADDRESS like /report', async () => {
    const app = server(() => { throw new Error('not reached'); });
    expect((await app.inject('/vaults/0x000000000000000000000000000000000000dEaD/peak')).json().error.code).toBe('VAULT_NOT_TRACKED');
    expect((await app.inject('/vaults/zzz/peak')).json().error.code).toBe('INVALID_ADDRESS');
  });
});
