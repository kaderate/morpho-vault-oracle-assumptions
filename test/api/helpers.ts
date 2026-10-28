import { zeroAddress } from 'viem';
import { erc20Abi, MORPHO, morphoAbi, oracleAbi } from '../../src/chain/abis.js';
import type { Address, Hex } from '../../src/types.js';
import fixture from '../fixtures/oracles.json' with { type: 'json' };
import { FakeChain } from '../helpers/fakeChain.js';

export const USDE_META: Address = '0xF4b17C79492d68775e22e8Dd0a2Bb22854A39A47';
export const CBBTC_ORACLE: Address = '0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9';
export const USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const USDE: Address = '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34';
export const CBBTC: Address = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
export const MARKET_USDE: Hex = '0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354';
export const MARKET_CBBTC: Hex = `0x${'c'.repeat(64)}`;
export const MARKET_UNKNOWN: Hex = `0x${'d'.repeat(64)}`;
export const MARKET_IDLE: Hex = `0x${'e'.repeat(64)}`;
export const MARKET_BADORACLE: Hex = `0x${'f'.repeat(64)}`;
export { oracleAbi };

// Markets on a fake chain loaded with the real recorded oracle answers.
export function marketChain(): FakeChain {
  const c = new FakeChain().load(fixture.calls as Record<string, string | null>);
  c.on(USDC, erc20Abi, 'symbol', [], 'USDC').on(USDC, erc20Abi, 'decimals', [], 6)
    .on(USDE, erc20Abi, 'symbol', [], 'USDe').on(USDE, erc20Abi, 'decimals', [], 18)
    .on(CBBTC, erc20Abi, 'symbol', [], 'cbBTC').on(CBBTC, erc20Abi, 'decimals', [], 8)
    .on(MORPHO, morphoAbi, 'idToMarketParams', [MARKET_USDE], [USDC, USDE, USDE_META, zeroAddress, 915000000000000000n])
    .on(MORPHO, morphoAbi, 'idToMarketParams', [MARKET_CBBTC], [USDC, CBBTC, CBBTC_ORACLE, zeroAddress, 860000000000000000n])
    .on(MORPHO, morphoAbi, 'idToMarketParams', [MARKET_IDLE], [USDC, zeroAddress, zeroAddress, zeroAddress, 0n])
    .on(MORPHO, morphoAbi, 'idToMarketParams', [MARKET_BADORACLE], [USDC, CBBTC, '0x0000000000000000000000000000000000000bad', zeroAddress, 860000000000000000n])
    .on(MORPHO, morphoAbi, 'idToMarketParams', [MARKET_UNKNOWN], [zeroAddress, zeroAddress, zeroAddress, zeroAddress, 0n]);
  return c;
}
