import { zeroAddress } from 'viem';
import type { Address, ChainReader, Hex, MarketInfo } from '../types.js';
import { MORPHO, morphoAbi } from './abis.js';
import { read } from './call.js';

// Morpho Blue market params are immutable. null = no such market (loan token is the zero address).
// A market with a zero collateral is an idle market: returned as is, the caller skips it.
export async function readMarket(reader: ChainReader, marketId: Hex, block?: bigint): Promise<MarketInfo | null> {
  const p = await read<readonly [Address, Address, Address, Address, bigint]>(
    reader, MORPHO, morphoAbi, 'idToMarketParams', [marketId], block,
  );
  if (p === null) throw new Error(`idToMarketParams(${marketId}) reverted`);
  const [loan, collateral, oracle, , lltv] = p;
  if (loan === zeroAddress) return null;
  return { id: marketId, loan, collateral, oracle, lltv };
}
