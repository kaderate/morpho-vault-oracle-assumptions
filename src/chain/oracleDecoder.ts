import { zeroAddress } from 'viem';
import type { Address, ChainReader, DecodedOracle, ReasonCode } from '../types.js';
import { oracleAbi } from './abis.js';
import { read } from './call.js';

type Meta = Extract<DecodedOracle, { class: 'metaoracle' }>;

const unknown = (address: Address, reasonCode: ReasonCode, reason: string): DecodedOracle => ({
  class: 'unknown',
  address,
  reasonCode,
  reason,
});

// Reads an oracle into one of: fixed, chainlink (Morpho Chainlink oracle V2), metaoracle
// (Steakhouse MetaOracleDeviationTimelock, one nesting level), or unknown with a reason.
// A reverting oracle never throws: that market becomes `unknown` and the rest of the report is served.
export async function decodeOracle(
  reader: ChainReader,
  address: Address,
  block?: bigint,
  depth = 0,
): Promise<DecodedOracle> {
  const get = <T>(fn: string) => read<T>(reader, address, oracleAbi, fn, [], block);

  const feed1 = await get<Address>('BASE_FEED_1');
  if (feed1 !== null) return decodeChainlink(address, feed1, get);

  const primary = await get<Address>('primaryOracle');
  if (primary === null) {
    return unknown(address, 'ORACLE_REVERTED', 'no oracle getter answered (calls reverted)');
  }
  if (depth > 0) return unknown(address, 'ORACLE_UNSUPPORTED', 'MetaOracle nested inside a MetaOracle');
  return decodeMeta(reader, address, primary, get, block);
}

async function decodeChainlink(
  address: Address,
  feed1: Address,
  get: <T>(fn: string) => Promise<T | null>,
): Promise<DecodedOracle> {
  // QUOTE_* getters price the loan token (the lender's own asset); only the collateral side is reported.
  const [feed2, baseVault] = await Promise.all([get<Address>('BASE_FEED_2'), get<Address>('BASE_VAULT')]);
  const set = (a: Address | null): a is Address => a !== null && a !== zeroAddress;
  const feeds = [feed1, feed2].filter(set);
  if (feeds.length === 0 && !set(baseVault)) {
    // A fixed base price is only a "fixed USD price" when nothing on the quote side moves it.
    const quote = await Promise.all([get<Address>('QUOTE_FEED_1'), get<Address>('QUOTE_FEED_2'), get<Address>('QUOTE_VAULT')]);
    if (quote.some(set)) return unknown(address, 'ORACLE_UNSUPPORTED', 'fixed base price combined with a quote-side feed or vault');
    return { class: 'fixed', address };
  }
  return { class: 'chainlink', address, feeds, ...(set(baseVault) ? { baseVault } : {}) };
}

async function decodeMeta(
  reader: ChainReader,
  address: Address,
  primaryAddress: Address,
  get: <T>(fn: string) => Promise<T | null>,
  block?: bigint,
): Promise<DecodedOracle> {
  const [backupAddress, threshold, challenge, healing, deviation, challenged, backup, healingNow] = await Promise.all([
    get<Address>('backupOracle'),
    get<bigint>('deviationThreshold'),
    get<bigint>('challengeTimelockDuration'),
    get<bigint>('healingTimelockDuration'),
    get<bigint>('getDeviation'),
    get<boolean>('isChallenged'),
    get<boolean>('isBackup'),
    get<boolean>('isHealing'),
  ]);
  if (
    backupAddress === null || threshold === null || challenge === null || healing === null ||
    deviation === null || challenged === null || backup === null || healingNow === null
  ) {
    return unknown(address, 'ORACLE_REVERTED', 'a MetaOracle getter reverted');
  }
  const [primary, backupOracle] = await Promise.all([
    decodeOracle(reader, primaryAddress, block, 1),
    decodeOracle(reader, backupAddress, block, 1),
  ]);

  const state: Meta['state'] = challenged ? 'challenged' : backup ? 'backup' : healingNow ? 'healing' : 'primary';
  const meta: Meta = {
    class: 'metaoracle',
    address,
    primary,
    backup: backupOracle,
    deviationThreshold: threshold,
    deviation,
    challengeSeconds: Number(challenge),
    healingSeconds: Number(healing),
    state,
  };
  if (state === 'challenged') {
    const at = await get<bigint>('challengeExpiresAt');
    if (at !== null && at > 0n) meta.challengeExpiresAt = Number(at);
  }
  if (state === 'healing') {
    const at = await get<bigint>('healingExpiresAt');
    if (at !== null && at > 0n) meta.healingExpiresAt = Number(at);
  }
  return meta;
}
