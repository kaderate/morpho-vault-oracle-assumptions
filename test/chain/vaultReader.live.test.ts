import { describe, expect, it } from 'vitest';
import { readVault } from '../../src/chain/vaultReader.js';
import { liveReader } from '../helpers/liveReader.js';

const DEMO = '0xbeeff2490FEffa212faC2f6553682C219E6a8845';
const USDE_MARKET = '0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354';

describe.skipIf(!process.env.RPC_URL)('readVault on the demo vault (Base)', () => {
  it('has at least 6 positions that add up to totalAssets, ~76% in the USDe market', async () => {
    const reader = liveReader(process.env.RPC_URL as string);
    // Pin one block: reads at `latest` can straddle two blocks and drift by a few USDC.
    const block = (await reader.blockNumber()) - 5n;
    const v = await readVault(reader, DEMO, block);
    expect(v.positions.length).toBeGreaterThanOrEqual(6); // the allocator adds markets over time: 6 at the start, 8 later
    const sum = v.positions.reduce((s, p) => s + p.assets, 0n);
    const gap = v.totalAssets > sum ? v.totalAssets - sum : sum - v.totalAssets;
    expect(gap <= 1_000n).toBe(true); // USDC has 6 decimals: 1,000 units = 0.001 USDC
    const usde = v.positions.find((p) => p.marketId === USDE_MARKET)!;
    const sharePct = Number((usde.assets * 10_000n) / v.totalAssets) / 100;
    expect(sharePct).toBeGreaterThan(70);
    expect(sharePct).toBeLessThan(80);
    expect(v.unknownAdapters).toEqual([]);
  });
});
