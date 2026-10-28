import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../src/analysis/registry.js';
import { buildReport } from '../src/report.js';
import { createViemReader } from '../src/chain/reader.js';
import { totalPct } from './helpers/vaultScenario.js';

describe.skipIf(!process.env.RPC_URL)('buildReport on the demo vault (Base)', () => {
  it('has a usde:usd exposure between 70% and 80% frozen for 57600s', async () => {
    const r = await buildReport(
      { reader: createViemReader(process.env.RPC_URL as string), registry: loadRegistry('registry') },
      '0xbeeff2490FEffa212faC2f6553682C219E6a8845',
    );
    const usde = r.exposures.find((e) => e.assumptionId === 'usde:usd');
    expect(usde?.sharePct).toBeGreaterThan(70);
    expect(usde?.sharePct).toBeLessThan(80);
    expect(usde?.frozenFor).toMatchObject({ kind: 'timelock', seconds: 57600 });
    const sum = totalPct(r);
    expect(Math.abs(sum - 100)).toBeLessThanOrEqual(0.1);
  });
});
