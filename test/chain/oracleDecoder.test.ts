import { describe, expect, it } from 'vitest';
import { decodeOracle } from '../../src/chain/oracleDecoder.js';
import { oracleAbi } from '../../src/chain/abis.js';
import fixture from '../fixtures/oracles.json' with { type: 'json' };
import { encodeFunctionData } from 'viem';
import { answer, fakeReader } from '../helpers/fakeReader.js';

const USDE_META = '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47';
const CBBTC = '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9';
const USDC_FEED = '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B';
const CBBTC_FEED = '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F';

describe('decodeOracle (real Base fixtures)', () => {
  it('decodes the USDe/USDC MetaOracle', async () => {
    const o = await decodeOracle(fakeReader(fixture), USDE_META);
    expect(o.class).toBe('metaoracle');
    if (o.class !== 'metaoracle') return;
    expect(o.primary.class).toBe('fixed');
    expect(o.backup.class).toBe('chainlink');
    if (o.backup.class === 'chainlink') expect(o.backup.feeds).toHaveLength(1);
    expect(o.deviationThreshold).toBe(5000000000000000n);
    // Expected value comes from the recorded call itself (the deviation moves with the block).
    const data = encodeFunctionData({ abi: oracleAbi, functionName: 'getDeviation' });
    const recorded = (fixture.calls as Record<string, string | null>)[`${USDE_META.toLowerCase()}:${data}`];
    expect(o.deviation).toBe(BigInt(recorded as string));
    expect(o.challengeSeconds).toBe(57600);
    expect(o.healingSeconds).toBe(86400);
    expect(o.state).toBe('primary');
    expect(o.challengeExpiresAt).toBeUndefined();
    expect(o.healingExpiresAt).toBeUndefined();
  });

  it('reports a challenged MetaOracle with its expiry', async () => {
    const reader = fakeReader(fixture, {
      ...answer(oracleAbi, USDE_META, 'isChallenged', 'bool', true),
      ...answer(oracleAbi, USDE_META, 'challengeExpiresAt', 'uint256', 1_800_000_000n),
    });
    const o = await decodeOracle(reader, USDE_META);
    expect(o.class === 'metaoracle' && o.state).toBe('challenged');
    expect(o.class === 'metaoracle' && o.challengeExpiresAt).toBe(1_800_000_000);
  });

  it('decodes the cbBTC/USDC oracle as chainlink with one feed', async () => {
    const o = await decodeOracle(fakeReader(fixture), CBBTC);
    expect(o).toMatchObject({ class: 'chainlink', feeds: [CBBTC_FEED] });
  });

  it('returns unknown ORACLE_REVERTED when every call reverts', async () => {
    const o = await decodeOracle(fakeReader({ block: '1', calls: {} }), CBBTC);
    expect(o).toMatchObject({ class: 'unknown', reasonCode: 'ORACLE_REVERTED' });
    expect(o.class === 'unknown' && o.reason).toMatch(/revert/i);
  });

  it('keeps a chainlink oracle as chainlink even when its feeds do not answer', async () => {
    // Feeds are only recorded as addresses; nothing reads them.
    const o = await decodeOracle(fakeReader(fixture), CBBTC);
    expect(o.class).toBe('chainlink');
  });

  it('ignores quote-side feeds: they price the loan token, not the collateral', async () => {
    const reader = fakeReader(fixture, answer(oracleAbi, CBBTC, 'QUOTE_FEED_1', 'address', USDC_FEED));
    const o = await decodeOracle(reader, CBBTC);
    expect(o).toMatchObject({ class: 'chainlink', feeds: [CBBTC_FEED] });
  });
});
