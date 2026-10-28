import { describe, expect, it } from 'vitest';
import { decodeOracle } from '../../src/chain/oracleDecoder.js';
import { oracleAbi } from '../../src/chain/abis.js';
import { FakeChain, recordedOracles } from '../helpers/fakeChain.js';

const USDE_META = '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47';
const CBBTC = '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9';
const USDC_FEED = '0x7e860098F58bBFC8648a4311b374B1D669a2bc6B';
const CBBTC_FEED = '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F';

describe('decodeOracle (real Base fixtures)', () => {
  it('decodes the USDe/USDC MetaOracle', async () => {
    const o = await decodeOracle(recordedOracles(), USDE_META);
    expect(o.class).toBe('metaoracle');
    if (o.class !== 'metaoracle') return;
    expect(o.primary.class).toBe('fixed');
    expect(o.backup.class).toBe('chainlink');
    if (o.backup.class === 'chainlink') expect(o.backup.feeds).toHaveLength(1);
    expect(o.challengeSeconds).toBe(57600);
    expect(o.state).toBe('primary');
    expect(o.challengeExpiresAt).toBeUndefined();
  });

  it('reports a challenged MetaOracle with its expiry', async () => {
    const reader = recordedOracles()
      .on(USDE_META, oracleAbi, 'isChallenged', [], true)
      .on(USDE_META, oracleAbi, 'challengeExpiresAt', [], 1_800_000_000n);
    const o = await decodeOracle(reader, USDE_META);
    expect(o.class === 'metaoracle' && o.state).toBe('challenged');
    expect(o.class === 'metaoracle' && o.challengeExpiresAt).toBe(1_800_000_000);
  });

  it('decodes the cbBTC/USDC oracle as chainlink with one feed', async () => {
    const o = await decodeOracle(recordedOracles(), CBBTC);
    expect(o).toMatchObject({ class: 'chainlink', feeds: [CBBTC_FEED] });
  });

  it('returns unknown ORACLE_REVERTED when every call reverts', async () => {
    const o = await decodeOracle(new FakeChain(), CBBTC);
    expect(o).toMatchObject({ class: 'unknown', reasonCode: 'ORACLE_REVERTED' });
    expect(o.class === 'unknown' && o.reason).toMatch(/revert/i);
  });

  it('ignores quote-side feeds: they price the loan token, not the collateral', async () => {
    const reader = recordedOracles().on(CBBTC, oracleAbi, 'QUOTE_FEED_1', [], USDC_FEED);
    const o = await decodeOracle(reader, CBBTC);
    expect(o).toMatchObject({ class: 'chainlink', feeds: [CBBTC_FEED] });
  });

  it('a fixed base price combined with a quote feed is not "fixed": unknown ORACLE_UNSUPPORTED', async () => {
    const reader = recordedOracles()
      .on(CBBTC, oracleAbi, 'BASE_FEED_1', [], '0x0000000000000000000000000000000000000000')
      .on(CBBTC, oracleAbi, 'QUOTE_FEED_1', [], USDC_FEED);
    expect(await decodeOracle(reader, CBBTC)).toMatchObject({ class: 'unknown', reasonCode: 'ORACLE_UNSUPPORTED' });
  });
});
