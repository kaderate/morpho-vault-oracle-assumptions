import type { Address, DecodedOracle, ReasonCode } from '../types.js';
import type { FeedInfo, Registry } from './registry.js';

export type Assumption =
  | { kind: 'assumption'; id: string; text: string }
  | { kind: 'none' }
  | { kind: 'unknown'; reasonCode: ReasonCode; reason: string };

const unknown = (reasonCode: ReasonCode, reason: string): Assumption => ({ kind: 'unknown', reasonCode, reason });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// The hidden bet a lender takes on the collateral side: what the oracle assumes the collateral is worth.
// The registry decides what a feed means; whatever it does not cover is `unknown`, never guessed.
export function deriveAssumption(collateral: Address, oracle: DecodedOracle, registry: Registry): Assumption {
  switch (oracle.class) {
    case 'unknown':
      return unknown(oracle.reasonCode, oracle.reason);
    case 'metaoracle':
      return deriveAssumption(collateral, oracle.primary, registry); // the primary price is the one used day to day
    case 'fixed': {
      const token = registry.tokens.get(collateral);
      if (!token) return unknown('TOKEN_NOT_IN_REGISTRY', `token ${collateral} is not in registry/tokens.json`);
      if (token.peg !== 'USD') {
        return unknown('FIXED_PRICE_UNPEGGED', `${token.symbol} has a fixed price but no USD peg in registry/tokens.json`);
      }
      return { kind: 'assumption', id: `${token.symbol.toLowerCase()}:usd`, text: `${token.symbol} = 1 USD` };
    }
    case 'chainlink': {
      if (oracle.feeds.length === 0) return unknown('ORACLE_UNSUPPORTED', 'ERC4626 base vault without a feed is not covered');
      const feeds: FeedInfo[] = [];
      for (const address of oracle.feeds) {
        const feed = registry.feeds.get(address);
        if (!feed) return unknown('FEED_NOT_IN_REGISTRY', `feed ${address} is not in registry/feeds.json`);
        feeds.push(feed);
      }
      const token = registry.tokens.get(collateral);
      if (!token) return unknown('TOKEN_NOT_IN_REGISTRY', `token ${collateral} is not in registry/tokens.json`);

      if (feeds.some((f) => f.type === 'exchange_rate')) {
        return { kind: 'assumption', id: `${token.symbol.toLowerCase()}:exchange-rate`, text: `${token.symbol} = protocol exchange rate` };
      }
      const [first, second] = feeds as [FeedInfo, FeedInfo | undefined];
      const endsInUsd = second ? same(first.quote, second.base) && second.quote === 'USD' : first.quote === 'USD';
      if (!endsInUsd) return unknown('ORACLE_UNSUPPORTED', `feeds ${first.description}${second ? ` + ${second.description}` : ''} do not price in USD`);

      const priced = first.base;
      if (same(priced, token.symbol) || token.trivialWith?.some((a) => same(a, priced))) return { kind: 'none' };
      return { kind: 'assumption', id: `${token.symbol.toLowerCase()}:${priced.toLowerCase()}`, text: `${token.symbol} = ${priced}` };
    }
  }
}
