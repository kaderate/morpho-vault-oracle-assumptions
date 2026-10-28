import type { DecodedOracle, FrozenFor } from '../types.js';
import type { FeedInfo, Registry } from './registry.js';

// How long the oracle can keep its current price while the real price moves.
// `now` (unix seconds) is the block timestamp, used for the remaining time of a challenge.
export function frozenFor(oracle: DecodedOracle, registry: Registry, now: number): FrozenFor {
  switch (oracle.class) {
    case 'unknown':
      return { kind: 'unknown', reasonCode: oracle.reasonCode };
    case 'fixed':
      return { kind: 'unbounded' };
    case 'metaoracle': {
      if (oracle.state === 'backup' || oracle.state === 'healing') return frozenFor(oracle.backup, registry, now);
      if (oracle.primary.class !== 'fixed') return frozenFor(oracle.primary, registry, now);
      // Primary is a fixed price: it can only be left after the challenge timelock, and someone must trigger the switch.
      if (oracle.state === 'challenged' && oracle.challengeExpiresAt !== undefined) {
        return {
          kind: 'timelock',
          seconds: Math.max(0, oracle.challengeExpiresAt - now),
          state: 'challenged',
          expiresAt: oracle.challengeExpiresAt,
        };
      }
      return { kind: 'timelock', seconds: oracle.challengeSeconds, state: oracle.state };
    }
    case 'chainlink': {
      const feeds: FeedInfo[] = [];
      for (const address of oracle.feeds) {
        const feed = registry.feeds.get(address);
        if (!feed) return { kind: 'unknown', reasonCode: 'FEED_NOT_IN_REGISTRY' };
        feeds.push(feed);
      }
      if (feeds.length === 0) return { kind: 'unknown', reasonCode: 'ORACLE_UNSUPPORTED' };
      // An exchange-rate feed follows the protocol's own rate, not the market: it does not move in a market depeg.
      if (feeds.some((f) => f.type === 'exchange_rate')) return { kind: 'unbounded' };
      if (feeds.some((f) => f.deviationPct === undefined || f.heartbeatSeconds === undefined)) {
        return { kind: 'unknown', reasonCode: 'FEED_NOT_IN_REGISTRY' }; // in the registry, but thresholds not confirmed
      }
      return {
        kind: 'feed_heartbeat',
        deviationPct: Math.max(...feeds.map((f) => f.deviationPct as number)),
        heartbeatSeconds: Math.max(...feeds.map((f) => f.heartbeatSeconds as number)),
      };
    }
  }
}
