import { beforeAll, describe, expect, it } from 'vitest';
import { deriveAssumption } from '../../src/analysis/assumptions.js';
import { loadRegistry } from '../../src/analysis/registry.js';
import { decodeOracle } from '../../src/chain/oracleDecoder.js';
import type { Address, DecodedOracle } from '../../src/types.js';
import fixture from '../fixtures/oracles.json' with { type: 'json' };
import { fakeReader } from '../helpers/fakeReader.js';

const registry = loadRegistry('registry');
const T = {
  USDe: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', cbBTC: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  WETH: '0x4200000000000000000000000000000000000006', cbXRP: '0xcb585250f852C6c6bf90434AB21A00f02833a4af',
  cbETH: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22', wstETH: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
  mGLO: '0xFCc9Cc1209651Ed8867332d6F664CF82743A2584',
} as const satisfies Record<string, Address>;
const F = {
  BTC_USD: '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F', ETH_USD: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  XRP_USD: '0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34', CBETH_ETH_RATE: '0x868a501e68F3D1E89CfC0D22F6b22E8dabce5F04',
  WSTETH_ETH: '0x43a5C292A453A3bF3606fa856197f09D7B74251a', MGLO: '0x3732F1E48499922426F9Ddad37D79C98B1fBf29E',
} as const satisfies Record<string, Address>;
const O: Address = '0x0000000000000000000000000000000000000abc';
const chainlink = (...feeds: Address[]): DecodedOracle => ({ class: 'chainlink', address: O, feeds });

describe('deriveAssumption', () => {
  let cbbtcOracle: DecodedOracle, usdeOracle: DecodedOracle;
  beforeAll(async () => {
    const reader = fakeReader(fixture);
    cbbtcOracle = await decodeOracle(reader, '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9');
    usdeOracle = await decodeOracle(reader, '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47');
  });

  it('cbBTC priced by BTC/USD → "cbBTC = BTC"', () => {
    expect(deriveAssumption(T.cbBTC, cbbtcOracle, registry)).toEqual({ kind: 'assumption', id: 'cbbtc:btc', text: 'cbBTC = BTC' });
  });

  it('USDe behind a MetaOracle with a fixed primary → "USDe = 1 USD"', () => {
    expect(deriveAssumption(T.USDe, usdeOracle, registry)).toEqual({ kind: 'assumption', id: 'usde:usd', text: 'USDe = 1 USD' });
  });

  it('cbXRP priced by XRP/USD → id cbxrp:xrp', () => {
    expect(deriveAssumption(T.cbXRP, chainlink(F.XRP_USD), registry)).toMatchObject({ kind: 'assumption', id: 'cbxrp:xrp' });
  });

  it('WETH priced by ETH/USD → none', () => {
    expect(deriveAssumption(T.WETH, chainlink(F.ETH_USD), registry)).toEqual({ kind: 'none' });
  });

  it('wstETH priced by WSTETH/ETH then ETH/USD → none (priced as itself)', () => {
    expect(deriveAssumption(T.wstETH, chainlink(F.WSTETH_ETH, F.ETH_USD), registry)).toEqual({ kind: 'none' });
  });

  it('cbETH with an exchange-rate feed → "cbETH = protocol exchange rate"', () => {
    expect(deriveAssumption(T.cbETH, chainlink(F.CBETH_ETH_RATE, F.ETH_USD), registry)).toEqual({
      kind: 'assumption', id: 'cbeth:exchange-rate', text: 'cbETH = protocol exchange rate',
    });
  });

  it('feed not in the registry → unknown FEED_NOT_IN_REGISTRY naming the feed', () => {
    const r = deriveAssumption(T.mGLO, chainlink(F.MGLO), registry);
    expect(r).toMatchObject({ kind: 'unknown', reasonCode: 'FEED_NOT_IN_REGISTRY' });
    expect(r.kind === 'unknown' && r.reason).toContain(F.MGLO);
  });

  it('known feed but collateral not in the registry → TOKEN_NOT_IN_REGISTRY', () => {
    expect(deriveAssumption(T.mGLO, chainlink(F.BTC_USD), registry)).toMatchObject({ kind: 'unknown', reasonCode: 'TOKEN_NOT_IN_REGISTRY' });
  });

  it('fixed price on a token without a USD peg → FIXED_PRICE_UNPEGGED', () => {
    expect(deriveAssumption(T.cbBTC, { class: 'fixed', address: O }, registry)).toMatchObject({ kind: 'unknown', reasonCode: 'FIXED_PRICE_UNPEGGED' });
  });

  it('a single feed that does not end in USD → ORACLE_UNSUPPORTED', () => {
    expect(deriveAssumption(T.wstETH, chainlink(F.WSTETH_ETH), registry)).toMatchObject({ kind: 'unknown', reasonCode: 'ORACLE_UNSUPPORTED' });
  });

  it('an unknown oracle passes its reason through', () => {
    const o: DecodedOracle = { class: 'unknown', address: O, reasonCode: 'ORACLE_REVERTED', reason: 'boom' };
    expect(deriveAssumption(T.cbBTC, o, registry)).toEqual({ kind: 'unknown', reasonCode: 'ORACLE_REVERTED', reason: 'boom' });
  });
});
