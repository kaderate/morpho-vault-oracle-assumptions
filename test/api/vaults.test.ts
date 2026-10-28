import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';
import { buildServer } from '../../src/api/server.js';
import { createMemoryRepo } from '../helpers/memoryRepo.js';
import { scenario, VAULT } from '../helpers/vaultScenario.js';

const registry = loadRegistry('registry');
const reader = () => scenario(1_000_000n, []);

describe('GET /vaults', () => {
  it('lists the tracked vaults with name, asset, block and asOf; lastSnapshotBlock is null without a repo', async () => {
    const res = await buildServer({ reader: reader(), registry, vaults: [getAddress(VAULT)] }).inject('/vaults');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      block: 100, asOf: '2023-11-14T22:13:20.000Z',
      vaults: [{ address: getAddress(VAULT), name: 'Test Vault', asset: { symbol: 'USDC', decimals: 6 }, lastSnapshotBlock: null }],
    });
  });

  it('reports the block of the latest stored snapshot when there is a repo', async () => {
    const { repo } = createMemoryRepo();
    await repo.insertSnapshot({ vault: getAddress(VAULT), block: 99n, blockHash: `0x${'1'.repeat(64)}`, ts: new Date(), totalAssets: 1n, positions: [] });
    const res = await buildServer({ reader: reader(), registry, vaults: [getAddress(VAULT)], repo }).inject('/vaults');
    expect(res.json().vaults[0].lastSnapshotBlock).toBe(99);
  });

  it('lastSnapshotBlock is null when the repo has no snapshot yet', async () => {
    const { repo } = createMemoryRepo();
    const res = await buildServer({ reader: reader(), registry, vaults: [getAddress(VAULT)], repo }).inject('/vaults');
    expect(res.json().vaults[0].lastSnapshotBlock).toBeNull();
  });
});
