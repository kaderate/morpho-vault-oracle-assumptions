import { encodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';
import { buildServer } from '../../src/api/server.js';
import { oracleAbi } from '../../src/chain/abis.js';
import fixture from '../fixtures/oracles.json' with { type: 'json' };
import { answer } from '../helpers/fakeReader.js';
import { CBBTC_ORACLE, MARKET_BADORACLE, MARKET_CBBTC, MARKET_IDLE, MARKET_UNKNOWN, MARKET_USDE, marketChain, USDE_META } from './helpers.js';

const registry = loadRegistry('registry');
const app = (chain = marketChain()) => buildServer({ reader: chain, registry, vaults: [] });

describe('GET /markets/:id/oracle', () => {
  it('decodes the USDe MetaOracle market', async () => {
    const res = await app().inject(`/markets/${MARKET_USDE}/oracle`);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    const recorded = (fixture.calls as unknown as Record<string, string>)[`${USDE_META.toLowerCase()}:${encodeFunctionData({ abi: oracleAbi, functionName: 'getDeviation' })}`]!;
    expect(b).toMatchObject({
      marketId: MARKET_USDE, block: 100, asOf: '2023-11-14T22:13:20.000Z',
      collateral: { address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', symbol: 'USDe' }, loan: { symbol: 'USDC' },
      lltvPct: 91.5, assumptionId: 'usde:usd', assumption: 'USDe = 1 USD',
      frozenFor: { kind: 'timelock', seconds: 57600, state: 'primary', human: 'at least 16h' },
      breakpoints: { drainPct: 8.5, badDebtPct: 6.1 },
    });
    expect(b.oracle).toMatchObject({
      address: USDE_META, class: 'metaoracle', state: 'primary', primary: { class: 'fixed' },
      backup: { class: 'chainlink', feeds: [{ address: '0x790181e93e9F4Eedb5b864860C12e4d2CffFe73B', pair: 'USDe / USD', type: 'market', deviationPct: 0.5, heartbeatSeconds: 86400 }] },
      deviationThresholdPct: 0.5,
      challenge: { seconds: 57600, human: '16h', expiresAt: null }, healing: { seconds: 86400, human: '24h', expiresAt: null },
    });
    expect(b.oracle.deviationPct).toBe(Math.round((Number(BigInt(recorded)) / 1e18) * 100 * 1000) / 1000);
  });

  it('a challenged oracle carries the challenge expiry and the remaining time', async () => {
    const chain = marketChain();
    const expires = 1_700_000_000 + 10_800;
    for (const [k, v] of Object.entries({
      ...answer(oracleAbi, USDE_META, 'isChallenged', 'bool', true),
      ...answer(oracleAbi, USDE_META, 'challengeExpiresAt', 'uint256', BigInt(expires)),
    })) chain.load({ [k]: v });
    const b = (await app(chain).inject(`/markets/${MARKET_USDE}/oracle`)).json();
    expect(b.oracle.state).toBe('challenged');
    expect(b.oracle.challenge.expiresAt).toBe(new Date(expires * 1000).toISOString());
    expect(b.frozenFor).toMatchObject({ kind: 'timelock', seconds: 10_800, state: 'challenged', human: '3h left' });
  });

  it('a chainlink oracle lists its feeds with registry pair and thresholds', async () => {
    const b = (await app().inject(`/markets/${MARKET_CBBTC}/oracle`)).json();
    expect(b).toMatchObject({ assumptionId: 'cbbtc:btc', frozenFor: { kind: 'feed_heartbeat', heartbeatSeconds: 1200 } });
    expect(b.oracle).toMatchObject({ class: 'chainlink', feeds: [{ pair: 'BTC / USD', type: 'market', deviationPct: 0.1, heartbeatSeconds: 1200 }] });
  });

  it('an oracle that reverts is reported as unknown with a reason, not as an error', async () => {
    const res = await app().inject(`/markets/${MARKET_BADORACLE}/oracle`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      assumptionId: null, assumption: null, oracle: { class: 'unknown', reasonCode: 'ORACLE_REVERTED' },
      unknown: { reasonCode: 'ORACLE_REVERTED' }, frozenFor: { kind: 'unknown' },
    });
  });

  it('404 MARKET_NOT_FOUND for an unknown market and for a market without collateral', async () => {
    for (const id of [MARKET_UNKNOWN, MARKET_IDLE]) {
      const res = await app().inject(`/markets/${id}/oracle`);
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe('MARKET_NOT_FOUND');
    }
  });

  it('400 INVALID_PARAMETER for a malformed market id', async () => {
    const res = await app().inject('/markets/0x1234/oracle');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PARAMETER');
  });
});
void CBBTC_ORACLE;
