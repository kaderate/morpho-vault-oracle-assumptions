import { formatUnits, zeroAddress } from 'viem';
import { RevertedError } from '../chain/errors.js';
import { decodeOracle } from '../chain/oracleDecoder.js';
import { readMarket } from '../chain/marketReader.js';
import { readToken, readVault } from '../chain/vaultReader.js';
import type { Address, ChainReader, DecodedOracle, FrozenFor, Hex, MarketInfo, ReasonCode } from '../types.js';
import { deriveAssumption, type Assumption } from './assumptions.js';
import { breakpoints } from './breakpoints.js';
import { frozenFor } from './frozenFor.js';
import type { Registry } from './registry.js';

type Breakpoints = ReturnType<typeof breakpoints>;
export type FrozenForView = FrozenFor & { human: string };

export interface ReportMarket { id: Hex; collateral: string; loan: string; sharePct: number; lltvPct: number; breakpoints: Breakpoints }
export interface Exposure {
  assumptionId: string;
  assumption: string;
  oracleClass: 'fixed' | 'chainlink' | 'metaoracle' | 'unknown';
  sharePct: number;
  assets: string;
  frozenFor: FrozenForView;
  breakpoints: Breakpoints; // worst case (lowest) across the markets
  markets: ReportMarket[];
}
export interface Report {
  vault: Address;
  name: string;
  block: number;
  asOf: string;
  asset: { symbol: string; decimals: number };
  totalAssets: string;
  exposures: Exposure[];
  idle: { sharePct: number };
  noAssumption: { sharePct: number; markets: { id: Hex; collateral: string; loan: string; sharePct: number }[] };
  unknown: {
    sharePct: number;
    markets: { id: Hex; collateral: string; loan: string; sharePct: number; reasonCode: ReasonCode; reason: string }[];
    adapters: { address: Address; reasonCode: ReasonCode }[]; // money we could not read; its share is in sharePct
  };
}

const pct = (part: bigint, total: bigint) => (total === 0n ? 0 : Number((part * 10_000n) / total) / 100);

export function durationHuman(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function describeFrozenFor(f: FrozenFor): FrozenForView {
  switch (f.kind) {
    case 'unbounded': return { ...f, human: 'no limit from the oracle' };
    case 'unknown': return { ...f, human: 'unknown' };
    case 'timelock':
      return { ...f, human: f.state === 'challenged' ? `${durationHuman(f.seconds)} left` : `at least ${durationHuman(f.seconds)}` };
    case 'feed_heartbeat':
      return { ...f, human: `until the feed updates (${f.deviationPct}% move or ${durationHuman(f.heartbeatSeconds)})` };
  }
}

interface Analyzed { market: ReportMarket; assets: bigint; oracleClass: Exposure['oracleClass']; frozen: FrozenFor; lltv: bigint }

// One market of the vault with everything the report and the snapshots need.
export interface AnalyzedMarket { market: MarketInfo; assets: bigint; oracle: DecodedOracle; assumption: Assumption }
export interface Analysis {
  report: Report;
  header: { number: bigint; hash: Hex; timestamp: number };
  totalAssets: bigint;
  markets: AnalyzedMarket[]; // markets with collateral, in position order; idle (no-collateral) markets are not here
}

export async function buildReport(deps: { reader: ChainReader; registry: Registry }, vault: Address, block?: bigint): Promise<Report> {
  return (await analyzeVault(deps, vault, block)).report;
}

// Builds the report at ONE block: every read is pinned to it, so totals and positions are consistent.
export async function analyzeVault(
  deps: { reader: ChainReader; registry: Registry },
  vault: Address,
  block?: bigint,
): Promise<Analysis> {
  const { reader, registry } = deps;
  const header = block === undefined ? await reader.latest() : await reader.block(block);
  const at = header.number;
  const v = await readVault(reader, vault, at);

  const tokens = new Map<Address, Promise<{ symbol: string; decimals: number; unreadable?: true }>>();
  // A token that cannot be read (decimals() reverts) must not sink the report: its market becomes unknown.
  const token = (a: Address) => {
    if (!tokens.has(a)) {
      tokens.set(a, readToken(reader, a, at).catch((e: unknown) => {
        if (e instanceof RevertedError) return { symbol: a as string, decimals: 0, unreadable: true as const };
        throw e;
      }));
    }
    return tokens.get(a)!;
  };

  const exposuresById = new Map<string, { text: string; items: Analyzed[] }>();
  const noAssumption: Report['noAssumption']['markets'] = [];
  const unknown: Report['unknown']['markets'] = [];
  let noAssumptionAssets = 0n;
  let unknownAssets = 0n;

  const analyzed = await Promise.all(v.positions.map(async (p) => {
    const m = await readMarket(reader, p.marketId, at);
    if (!m || m.collateral === zeroAddress) return null; // idle market: no collateral, nothing to assume
    const [collateral, loan, decoded] = await Promise.all([token(m.collateral), token(m.loan), decodeOracle(reader, m.oracle, at)]);
    const oracle: DecodedOracle = collateral.unreadable
      ? { class: 'unknown', address: m.oracle, reasonCode: 'TOKEN_UNREADABLE', reason: `collateral token ${m.collateral} cannot be read (decimals() reverts)` }
      : decoded;
    return { p, m, collateral, loan, oracle };
  }));

  const analyzedMarkets: AnalyzedMarket[] = [];
  for (const a of analyzed) {
    if (!a) continue;
    const { p, m, collateral, loan, oracle } = a;
    const sharePct = pct(p.assets, v.totalAssets);
    const d = deriveAssumption(m.collateral, oracle, registry);
    analyzedMarkets.push({ market: m, assets: p.assets, oracle, assumption: d });
    if (d.kind === 'none') {
      noAssumption.push({ id: m.id, collateral: collateral.symbol, loan: loan.symbol, sharePct });
      noAssumptionAssets += p.assets;
    } else if (d.kind === 'unknown') {
      unknown.push({ id: m.id, collateral: collateral.symbol, loan: loan.symbol, sharePct, reasonCode: d.reasonCode, reason: d.reason });
      unknownAssets += p.assets;
    } else {
      const entry = exposuresById.get(d.id) ?? { text: d.text, items: [] };
      entry.items.push({
        market: { id: m.id, collateral: collateral.symbol, loan: loan.symbol, sharePct, lltvPct: Number(m.lltv / 10n ** 14n) / 100, breakpoints: breakpoints(m.lltv) },
        assets: p.assets,
        oracleClass: oracle.class,
        frozen: frozenFor(oracle, registry, header.timestamp),
        lltv: m.lltv,
      });
      exposuresById.set(d.id, entry);
    }
  }

  let exposureAssets = 0n;
  const exposures: Exposure[] = [...exposuresById].map(([assumptionId, { text, items }]) => {
    items.sort((x, y) => (x.assets === y.assets ? 0 : x.assets > y.assets ? -1 : 1));
    const assets = items.reduce((s, i) => s + i.assets, 0n);
    exposureAssets += assets;
    const largest = items[0]!;
    return {
      assumptionId,
      assumption: text,
      oracleClass: largest.oracleClass,
      sharePct: pct(assets, v.totalAssets),
      assets: formatUnits(assets, v.asset.decimals),
      frozenFor: describeFrozenFor(largest.frozen), // the largest market stands for the group
      breakpoints: {
        drainPct: Math.min(...items.map((i) => i.market.breakpoints.drainPct)),
        badDebtPct: Math.min(...items.map((i) => i.market.breakpoints.badDebtPct)),
      },
      markets: items.map((i) => i.market),
    };
  });
  exposures.sort((x, y) => y.sharePct - x.sharePct);

  const known = exposureAssets + noAssumptionAssets + unknownAssets;
  let idleAssets = v.totalAssets > known ? v.totalAssets - known : 0n;
  // With an adapter we could not read, the remainder may be money in it: calling it idle would say "safe".
  const unknownAdapters = v.unknownAdapters.map((address) => ({ address, reasonCode: 'UNKNOWN_ADAPTER' as ReasonCode }));
  if (unknownAdapters.length > 0) {
    unknownAssets += idleAssets;
    idleAssets = 0n;
  }

  const report: Report = {
    vault,
    name: v.name,
    block: Number(at),
    asOf: new Date(header.timestamp * 1000).toISOString(),
    asset: { symbol: v.asset.symbol, decimals: v.asset.decimals },
    totalAssets: formatUnits(v.totalAssets, v.asset.decimals),
    exposures,
    idle: { sharePct: pct(idleAssets, v.totalAssets) },
    noAssumption: { sharePct: pct(noAssumptionAssets, v.totalAssets), markets: noAssumption },
    unknown: { sharePct: pct(unknownAssets, v.totalAssets), markets: unknown, adapters: unknownAdapters },
  };
  return { report, header, totalAssets: v.totalAssets, markets: analyzedMarkets };
}
