import { zeroAddress } from 'viem';
import { erc20Abi, MORPHO, marketAdapterAbi, morphoAbi, oracleAbi, vaultAdapterAbi, vaultV1Abi, vaultV2Abi } from '../../src/chain/abis.js';
import type { Address, Hex } from '../../src/types.js';
import { FakeChain } from './fakeChain.js';

// A small vault on a fake chain: one MorphoMarketV1 adapter, real token and feed addresses, synthetic oracles.
export const VAULT: Address = '0x00000000000000000000000000000000000000a1';
export const ADAPTER: Address = '0x00000000000000000000000000000000000000a2';
export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDE: Address = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34';
export const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
export const WETH: Address = '0x4200000000000000000000000000000000000006';
export const MGLO: Address = '0xFCc9Cc1209651Ed8867332d6F664CF82743A2584';
export const BTC_USD: Address = '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F';
export const ETH_USD: Address = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
export const MGLO_FEED: Address = '0x3732F1E48499922426F9Ddad37D79C98B1fBf29E';
export const oracleAddr = (n: number) => `0x00000000000000000000000000000000000001${n.toString(16).padStart(2, '0')}` as Address;
export const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export const LLTV_915 = 915000000000000000n;
export const LLTV_86 = 860000000000000000n;

export function fixedOracle(c: FakeChain, o: Address) {
  c.on(o, oracleAbi, 'BASE_FEED_1', [], zeroAddress).on(o, oracleAbi, 'BASE_FEED_2', [], zeroAddress).on(o, oracleAbi, 'BASE_VAULT', [], zeroAddress);
}
export function feedOracle(c: FakeChain, o: Address, feed: Address) {
  c.on(o, oracleAbi, 'BASE_FEED_1', [], feed).on(o, oracleAbi, 'BASE_FEED_2', [], zeroAddress).on(o, oracleAbi, 'BASE_VAULT', [], zeroAddress);
}
function symbol(c: FakeChain, t: Address, sym: string, decimals = 18) {
  c.on(t, erc20Abi, 'symbol', [], sym).on(t, erc20Abi, 'decimals', [], decimals);
}

export interface M { n: number; collateral: Address; oracle: Address; lltv: bigint; assets: bigint }
export function scenario(totalAssets: bigint, markets: M[], extraAdapters: Address[] = []) {
  const c = new FakeChain();
  c.on(VAULT, vaultV2Abi, 'name', [], 'Test Vault').on(VAULT, vaultV2Abi, 'asset', [], USDC)
    .on(VAULT, vaultV2Abi, 'totalAssets', [], totalAssets).on(VAULT, vaultV2Abi, 'adaptersLength', [], BigInt(1 + extraAdapters.length))
    .on(VAULT, vaultV2Abi, 'adapters', [0n], ADAPTER)
    .on(ADAPTER, marketAdapterAbi, 'marketIdsLength', [], BigInt(markets.length));
  extraAdapters.forEach((a, i) => c.on(VAULT, vaultV2Abi, 'adapters', [BigInt(i + 1)], a));
  symbol(c, USDC, 'USDC', 6); symbol(c, USDE, 'USDe'); symbol(c, CBBTC, 'cbBTC', 8); symbol(c, WETH, 'WETH'); symbol(c, MGLO, 'mGLO');
  markets.forEach((m, i) => {
    c.on(ADAPTER, marketAdapterAbi, 'marketIds', [BigInt(i)], id(m.n))
      .on(ADAPTER, marketAdapterAbi, 'expectedSupplyAssets', [id(m.n)], m.assets)
      .on(MORPHO, morphoAbi, 'idToMarketParams', [id(m.n)], [USDC, m.collateral, m.oracle, zeroAddress, m.lltv]);
  });
  return c;
}


export const V1_VAULT: Address = '0x00000000000000000000000000000000000000b1';
export const V1_ADAPTER: Address = '0x00000000000000000000000000000000000000b2';

// A vault whose only adapter is a MorphoVaultV1Adapter pointing at V1_VAULT, which holds the USDe market (1 position).
export function v1Scenario(totalAssets: bigint): FakeChain {
  const c = new FakeChain();
  c.on(VAULT, vaultV2Abi, 'name', [], 'Test Vault').on(VAULT, vaultV2Abi, 'asset', [], USDC)
    .on(VAULT, vaultV2Abi, 'totalAssets', [], totalAssets).on(VAULT, vaultV2Abi, 'adaptersLength', [], 1n)
    .on(VAULT, vaultV2Abi, 'adapters', [0n], V1_ADAPTER)
    .on(V1_ADAPTER, vaultAdapterAbi, 'morphoVaultV1', [], V1_VAULT)
    .on(V1_ADAPTER, vaultAdapterAbi, 'realAssets', [], totalAssets)
    .on(V1_VAULT, vaultV1Abi, 'withdrawQueueLength', [], 1n)
    .on(V1_VAULT, vaultV1Abi, 'withdrawQueue', [0n], id(1))
    .on(MORPHO, morphoAbi, 'position', [id(1), V1_VAULT], [totalAssets * 1_000_000n, 0n, 0n])
    .on(MORPHO, morphoAbi, 'market', [id(1)], [totalAssets, totalAssets * 1_000_000n, 0n, 0n, 0n, 0n])
    .on(MORPHO, morphoAbi, 'idToMarketParams', [id(1)], [USDC, USDE, oracleAddr(2), zeroAddress, LLTV_915]);
  symbol(c, USDC, 'USDC', 6); symbol(c, USDE, 'USDe');
  fixedOracle(c, oracleAddr(2));
  return c;
}

/** exposures + idle + noAssumption + unknown: must be 100 (±0.1) for any report. */
export const totalPct = (r: { exposures: { sharePct: number }[]; idle: { sharePct: number }; noAssumption: { sharePct: number }; unknown: { sharePct: number } }) =>
  r.exposures.reduce((s, e) => s + e.sharePct, 0) + r.idle.sharePct + r.noAssumption.sharePct + r.unknown.sharePct;
