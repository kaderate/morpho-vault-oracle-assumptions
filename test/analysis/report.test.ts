import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { buildReport } from '../../src/analysis/report.js';
import { loadRegistry } from '../../src/analysis/registry.js';
import {
  BTC_USD, CBBTC, ETH_USD, feedOracle, fixedOracle, id, LLTV_86, LLTV_915, MGLO, MGLO_FEED, oracleAddr, scenario, USDC, USDE, VAULT, WETH,
} from '../helpers/vaultScenario.js';

const registry = loadRegistry('registry');

describe('buildReport', () => {
  it('sums two markets with the same assumption and keeps the worst-case breakpoints', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: CBBTC, oracle: oracleAddr(1), lltv: LLTV_86, assets: 600_000n },
      { n: 2, collateral: CBBTC, oracle: oracleAddr(1), lltv: LLTV_915, assets: 300_000n },
    ]);
    feedOracle(c, oracleAddr(1), BTC_USD);
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures).toHaveLength(1);
    const e = r.exposures[0]!;
    expect(e).toMatchObject({ assumptionId: 'cbbtc:btc', assumption: 'cbBTC = BTC', oracleClass: 'chainlink', sharePct: 90, assets: '0.9' });
    expect(e.breakpoints).toEqual({ drainPct: 8.5, badDebtPct: 6.1 }); // the 91.5% market is the worst case
    expect(e.markets.map((m) => [m.lltvPct, m.sharePct, m.breakpoints.drainPct])).toEqual([[86, 60, 14], [91.5, 30, 8.5]]);
    expect(e.frozenFor).toMatchObject({ kind: 'feed_heartbeat', heartbeatSeconds: 1200, human: expect.any(String) });
  });

  it('adds idle when totalAssets exceeds the positions, and shares sum to 100', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 700_000n },
      { n: 2, collateral: WETH, oracle: oracleAddr(3), lltv: LLTV_86, assets: 200_000n },
    ]);
    fixedOracle(c, oracleAddr(2)); feedOracle(c, oracleAddr(3), ETH_USD);
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures[0]).toMatchObject({ assumptionId: 'usde:usd', sharePct: 70, frozenFor: { kind: 'unbounded' } });
    expect(r.idle.sharePct).toBe(10);
    expect(r.noAssumption).toMatchObject({ sharePct: 20, markets: [{ collateral: 'WETH', sharePct: 20 }] });
    const sum = r.exposures.reduce((s, e) => s + e.sharePct, 0) + r.idle.sharePct + r.noAssumption.sharePct + r.unknown.sharePct;
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
  });

  it('lists an unknown market apart with its reason and keeps it out of the exposures', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 800_000n },
      { n: 2, collateral: MGLO, oracle: oracleAddr(4), lltv: LLTV_915, assets: 200_000n },
    ]);
    fixedOracle(c, oracleAddr(2)); feedOracle(c, oracleAddr(4), MGLO_FEED);
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures.map((e) => e.assumptionId)).toEqual(['usde:usd']);
    expect(r.unknown.sharePct).toBe(20);
    expect(r.unknown.markets).toEqual([expect.objectContaining({
      id: id(2), collateral: 'mGLO', loan: 'USDC', reasonCode: 'FEED_NOT_IN_REGISTRY', reason: expect.stringContaining(MGLO_FEED),
    })]);
  });

  it('turns a reverting oracle into an unknown market and still serves the rest', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 500_000n },
      { n: 2, collateral: CBBTC, oracle: oracleAddr(9), lltv: LLTV_86, assets: 500_000n }, // oracleAddr(9) answers nothing
    ]);
    fixedOracle(c, oracleAddr(2));
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures).toHaveLength(1);
    expect(r.unknown.markets[0]).toMatchObject({ reasonCode: 'ORACLE_REVERTED' });
  });

  it('skips a market with no collateral: its assets fall into idle and the oracle is never read', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 600_000n },
      { n: 2, collateral: zeroAddress, oracle: zeroAddress, lltv: 0n, assets: 400_000n },
    ]);
    fixedOracle(c, oracleAddr(2));
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures).toHaveLength(1);
    expect(r.unknown.markets).toEqual([]);
    expect(r.idle.sharePct).toBe(40);
  });

  it('sorts exposures by share, pins every read to one block and reports block and asOf', async () => {
    const c = scenario(1_000_000n, [
      { n: 1, collateral: CBBTC, oracle: oracleAddr(1), lltv: LLTV_86, assets: 100_000n },
      { n: 2, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 900_000n },
    ]);
    feedOracle(c, oracleAddr(1), BTC_USD); fixedOracle(c, oracleAddr(2));
    const r = await buildReport({ reader: c, registry }, VAULT);
    expect(r.exposures.map((e) => e.assumptionId)).toEqual(['usde:usd', 'cbbtc:btc']);
    expect([...c.blocksSeen]).toEqual([100n]);
    expect(r).toMatchObject({ vault: VAULT, name: 'Test Vault', block: 100, asOf: '2023-11-14T22:13:20.000Z', stale: false, staleSeconds: null });
    expect(r.asset).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(r.totalAssets).toBe('1');
  });

  it('uses the block asked for', async () => {
    const c = scenario(1_000_000n, [{ n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 1_000_000n }]);
    fixedOracle(c, oracleAddr(2));
    const r = await buildReport({ reader: c, registry }, VAULT, 77n);
    expect(r.block).toBe(77);
    expect([...c.blocksSeen]).toEqual([77n]);
  });
});
