import { beforeAll, describe, expect, it } from 'vitest';
import { frozenFor } from '../../src/analysis/frozenFor.js';
import { loadRegistry } from '../../src/analysis/registry.js';
import { decodeOracle } from '../../src/chain/oracleDecoder.js';
import type { Address, DecodedOracle } from '../../src/types.js';
import fixture from '../fixtures/oracles.json' with { type: 'json' };
import { fakeReader } from '../helpers/fakeReader.js';

const registry = loadRegistry('registry');
const O: Address = '0x0000000000000000000000000000000000000abc';
const NOW = 1_800_000_000;
const chainlink = (...feeds: Address[]): DecodedOracle => ({ class: 'chainlink', address: O, feeds });
const BTC_USD: Address = '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F';
const ETH_USD: Address = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const CBETH_ETH: Address = '0x806b4Ac04501c29769051e42783cF04dCE41440b';
const RATE: Address = '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04';
const MGLO: Address = '0x3732F1E48499922426F9Ddad37D79C98B1fBf29E';

describe('frozenFor', () => {
  let usde: Extract<DecodedOracle, { class: 'metaoracle' }>;
  beforeAll(async () => {
    const o = await decodeOracle(fakeReader(fixture), '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47');
    if (o.class !== 'metaoracle') throw new Error('fixture changed');
    usde = o;
  });

  it('USDe MetaOracle on primary → timelock of the full challenge duration', () => {
    expect(frozenFor(usde, registry, NOW)).toEqual({ kind: 'timelock', seconds: 57600, state: 'primary' });
  });

  it('challenged with 3h left → remaining seconds and expiresAt', () => {
    const o = { ...usde, state: 'challenged' as const, challengeExpiresAt: NOW + 10800 };
    expect(frozenFor(o, registry, NOW)).toEqual({ kind: 'timelock', seconds: 10800, state: 'challenged', expiresAt: NOW + 10800 });
  });

  it('backup state → the backup oracle’s frozenFor (USDe/USD feed heartbeat)', () => {
    expect(frozenFor({ ...usde, state: 'backup' }, registry, NOW)).toEqual({ kind: 'feed_heartbeat', deviationPct: 0.5, heartbeatSeconds: 86400 });
  });

  it('fixed price → unbounded', () => {
    expect(frozenFor({ class: 'fixed', address: O }, registry, NOW)).toEqual({ kind: 'unbounded' });
  });

  it('exchange-rate feed → unbounded', () => {
    expect(frozenFor(chainlink(RATE, ETH_USD), registry, NOW)).toEqual({ kind: 'unbounded' });
  });

  it('market feed → heartbeat and deviation from the registry', () => {
    expect(frozenFor(chainlink(BTC_USD), registry, NOW)).toEqual({ kind: 'feed_heartbeat', deviationPct: 0.1, heartbeatSeconds: 1200 });
  });

  it('two market feeds → the largest heartbeat and the largest deviation', () => {
    expect(frozenFor(chainlink(CBETH_ETH, ETH_USD), registry, NOW)).toEqual({ kind: 'feed_heartbeat', deviationPct: 0.5, heartbeatSeconds: 86400 });
  });

  it('feed not in the registry → unknown', () => {
    expect(frozenFor(chainlink(MGLO), registry, NOW)).toEqual({ kind: 'unknown', reasonCode: 'FEED_NOT_IN_REGISTRY' });
  });

  it('market feed without thresholds → unknown', () => {
    const bare = { ...registry, feeds: new Map(registry.feeds) };
    const { deviationPct: _d, heartbeatSeconds: _h, ...rest } = bare.feeds.get(BTC_USD)!;
    bare.feeds.set(BTC_USD, rest);
    expect(frozenFor(chainlink(BTC_USD), bare, NOW)).toMatchObject({ kind: 'unknown' });
  });

  it('MetaOracle whose primary is not fixed → the primary’s frozenFor', () => {
    const o: DecodedOracle = { ...usde, primary: chainlink(RATE, ETH_USD) };
    expect(frozenFor(o, registry, NOW)).toEqual({ kind: 'unbounded' });
  });

  it('unknown oracle → unknown with its reason code', () => {
    const o: DecodedOracle = { class: 'unknown', address: O, reasonCode: 'ORACLE_REVERTED', reason: 'x' };
    expect(frozenFor(o, registry, NOW)).toEqual({ kind: 'unknown', reasonCode: 'ORACLE_REVERTED' });
  });
});
