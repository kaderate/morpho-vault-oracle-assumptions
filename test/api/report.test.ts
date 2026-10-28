import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';
import { buildServer } from '../../src/api/server.js';
import { fixedOracle, LLTV_915, oracleAddr, scenario, USDE, VAULT } from '../helpers/vaultScenario.js';
import { getAddress } from 'viem';
import { RpcUnavailableError } from '../../src/chain/errors.js';

const registry = loadRegistry('registry');
const server = () => {
  const chain = scenario(1_000_000n, [{ n: 1, collateral: USDE, oracle: oracleAddr(2), lltv: LLTV_915, assets: 760_000n }]);
  fixedOracle(chain, oracleAddr(2));
  return buildServer({ reader: chain, registry, vaults: [getAddress(VAULT)] });
};

describe('GET /vaults/:address/report', () => {
  it('returns the report with block, asOf, asset and decimal-string totalAssets', async () => {
    const res = await server().inject(`/vaults/${getAddress(VAULT)}/report`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      block: 100, asOf: '2023-11-14T22:13:20.000Z',
      asset: { symbol: 'USDC', decimals: 6 }, totalAssets: '1',
    });
    expect(body.exposures[0]).toMatchObject({ assumptionId: 'usde:usd', sharePct: 76 });
    expect(body.idle.sharePct).toBe(24);
  });

  it('accepts a lowercase address', async () => {
    const res = await server().inject(`/vaults/${VAULT.toLowerCase()}/report`);
    expect(res.statusCode).toBe(200);
    expect(res.json().vault).toBe(getAddress(VAULT));
  });

  it('honours ?block=', async () => {
    const res = await server().inject(`/vaults/${VAULT}/report?block=77`);
    expect(res.json().block).toBe(77);
  });

  it('404 VAULT_NOT_TRACKED for a valid address that is not configured', async () => {
    const res = await server().inject('/vaults/0x000000000000000000000000000000000000dEaD/report');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'VAULT_NOT_TRACKED', message: expect.stringContaining('0x000000000000000000000000000000000000dEaD') } });
  });

  it('400 INVALID_ADDRESS for something that is not an address', async () => {
    const res = await server().inject('/vaults/not-an-address/report');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_ADDRESS');
  });

  it('400 INVALID_PARAMETER for a block that is not a positive integer', async () => {
    const res = await server().inject(`/vaults/${VAULT}/report?block=abc`);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });

  it('500 INTERNAL_ERROR with the error shape when the chain read fails', async () => {
    const chain = scenario(1_000_000n, []);
    chain.call = async () => { throw new Error('rpc down'); };
    const res = await buildServer({ reader: chain, registry, vaults: [getAddress(VAULT)] }).inject(`/vaults/${VAULT}/report`);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
  });

  it('RPC down: 503 RPC_UNAVAILABLE', async () => {
    const chain = scenario(1_000_000n, []);
    chain.latest = async () => { throw new RpcUnavailableError('down'); };
    const res = await buildServer({ reader: chain, registry, vaults: [getAddress(VAULT)] }).inject(`/vaults/${VAULT}/report`);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('RPC_UNAVAILABLE');
  });

  it('404 BLOCK_NOT_AVAILABLE for a block that does not exist yet', async () => {
    const res = await server().inject(`/vaults/${VAULT}/report?block=999999`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BLOCK_NOT_AVAILABLE');
  });

  it('404 BLOCK_NOT_AVAILABLE when the vault did not exist at that block', async () => {
    const chain = scenario(1_000_000n, []);
    const real = chain.call.bind(chain);
    chain.call = async (to, data, block) => (block === 5n ? null : real(to, data, block));
    const res = await buildServer({ reader: chain, registry, vaults: [getAddress(VAULT)] }).inject(`/vaults/${VAULT}/report?block=5`);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatchObject({ code: 'BLOCK_NOT_AVAILABLE', message: expect.stringContaining('5') });
  });
});
