import Fastify, { type FastifyInstance } from 'fastify';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { deriveAssumption } from '../analysis/assumptions.js';
import { breakpoints } from '../analysis/breakpoints.js';
import { frozenFor } from '../analysis/frozenFor.js';
import { describeFrozenFor, durationHuman, buildReport } from '../analysis/report.js';
import type { Registry } from '../analysis/registry.js';
import { BlockNotFoundError, RevertedError, RpcUnavailableError } from '../chain/errors.js';
import { readMarket } from '../chain/marketReader.js';
import { decodeOracle } from '../chain/oracleDecoder.js';
import { readToken, readVaultMeta } from '../chain/vaultReader.js';
import type { Repo } from '../db/repo.js';
import type { Address, ChainReader, DecodedOracle, Hex } from '../types.js';

export interface ServerDeps {
  reader: ChainReader;
  registry: Registry;
  vaults: Address[];
  repo?: Repo;
  logger?: boolean;
  now?: () => Date; // tests
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const WAD = 10n ** 18n;
// A 1e18-scaled ratio as a percentage with 3 decimals (a percentage, not an amount).
const wadToPct = (x: bigint) => Number((x * 100_000n + WAD / 2n) / WAD) / 1000; // rounded, not truncated
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { reader, registry, repo } = deps;
  const now = deps.now ?? (() => new Date());
  const tracked = new Set(deps.vaults.map((v) => getAddress(v)));
  const app = Fastify({ logger: deps.logger ?? false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    if (err instanceof RpcUnavailableError) {
      req.log.warn({ err }, 'rpc unavailable');
      return reply.status(503).send({ error: { code: 'RPC_UNAVAILABLE', message: 'the RPC node could not be reached' } });
    }
    if (err instanceof BlockNotFoundError) {
      return reply.status(404).send({ error: { code: 'BLOCK_NOT_AVAILABLE', message: 'that block is not available on the node' } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'no such route' } }));

  function trackedVault(raw: string): Address {
    if (!isAddress(raw, { strict: false })) throw new ApiError(400, 'INVALID_ADDRESS', `"${raw}" is not an address`);
    const vault = getAddress(raw);
    if (!tracked.has(vault)) throw new ApiError(404, 'VAULT_NOT_TRACKED', `vault ${vault} is not in the tracked list`);
    return vault;
  }

  async function head() {
    const header = await reader.latest();
    return { block: Number(header.number), asOf: iso(header.timestamp), number: header.number, timestamp: header.timestamp };
  }

  app.get('/vaults', async () => {
    const { block, asOf, number } = await head();
    const vaults = await Promise.all(
      [...tracked].map(async (address) => {
        const meta = await readVaultMeta(reader, address, number);
        const snapshot = repo ? await repo.latestSnapshot(address) : null;
        return {
          address,
          name: meta.name,
          asset: { symbol: meta.asset.symbol, decimals: meta.asset.decimals },
          lastSnapshotBlock: snapshot ? Number(snapshot.block) : null,
        };
      }),
    );
    return { block, asOf, vaults };
  });

  app.get<{ Params: { address: string }; Querystring: { block?: string } }>('/vaults/:address/report', async (req) => {
    const vault = trackedVault(req.params.address);
    const raw = req.query.block;
    if (raw !== undefined && !/^[1-9]\d*$/.test(raw)) {
      throw new ApiError(400, 'INVALID_PARAMETER', `block must be a positive integer, got "${raw}"`);
    }
    const block = raw === undefined ? undefined : BigInt(raw);
    try {
      return await buildReport({ reader, registry }, vault, block);
    } catch (e) {
      if (e instanceof RevertedError && block !== undefined) {
        throw new ApiError(404, 'BLOCK_NOT_AVAILABLE', `vault ${vault} cannot be read at block ${block} (not deployed yet?)`);
      }
      throw e; // RpcUnavailableError becomes a 503 in the error handler
    }
  });

  app.get<{ Params: { address: string }; Querystring: { days?: string } }>('/vaults/:address/peak', async (req) => {
    const vault = trackedVault(req.params.address);
    const raw = req.query.days;
    if (raw !== undefined && !/^[1-9]\d{0,2}$/.test(raw)) {
      throw new ApiError(400, 'INVALID_PARAMETER', `days must be an integer between 1 and 365, got "${raw}"`);
    }
    const days = raw === undefined ? 30 : Number(raw);
    if (days > 365) throw new ApiError(400, 'INVALID_PARAMETER', `days must be an integer between 1 and 365, got "${raw}"`);
    if (!repo) throw new ApiError(501, 'NOT_IMPLEMENTED', 'peaks need the database, which this instance runs without');
    // Database only: "current" is the latest stored snapshot, and block/asOf say which one. While the first
    // backfill is running that snapshot is old, and the response shows it.
    const [r, latest] = await Promise.all([repo.peaks(vault, days, now()), repo.latestSnapshot(vault)]);
    return {
      vault,
      block: latest ? Number(latest.block) : null,
      asOf: latest ? latest.ts.toISOString() : null,
      windowDays: days,
      coverage: { from: r.coverage.from ? r.coverage.from.toISOString() : null, snapshots: r.coverage.snapshots, windowComplete: r.coverage.windowComplete },
      peaks: r.peaks.map((p) => ({
        assumptionId: p.assumptionId,
        assumption: p.assumption,
        currentSharePct: p.currentSharePct,
        peakSharePct: p.peakSharePct,
        peakBlock: Number(p.peakBlock),
        peakAt: p.peakAt.toISOString(),
      })),
    };
  });

  function oracleView(o: DecodedOracle): Record<string, unknown> {
    switch (o.class) {
      case 'fixed':
        return { address: o.address, class: 'fixed' };
      case 'unknown':
        return { address: o.address, class: 'unknown', reasonCode: o.reasonCode, reason: o.reason };
      case 'chainlink':
        return {
          address: o.address,
          class: 'chainlink',
          feeds: o.feeds.map((address) => {
            const f = registry.feeds.get(address);
            return { address, pair: f?.description ?? null, type: f?.type ?? null, deviationPct: f?.deviationPct ?? null, heartbeatSeconds: f?.heartbeatSeconds ?? null };
          }),
        };
      case 'metaoracle':
        return {
          address: o.address,
          class: 'metaoracle',
          state: o.state,
          primary: oracleView(o.primary),
          backup: oracleView(o.backup),
          deviationPct: wadToPct(o.deviation),
          deviationThresholdPct: wadToPct(o.deviationThreshold),
          challenge: { seconds: o.challengeSeconds, human: durationHuman(o.challengeSeconds), expiresAt: o.challengeExpiresAt ? iso(o.challengeExpiresAt) : null },
          healing: { seconds: o.healingSeconds, human: durationHuman(o.healingSeconds), expiresAt: o.healingExpiresAt ? iso(o.healingExpiresAt) : null },
        };
    }
  }

  app.get<{ Params: { id: string } }>('/markets/:id/oracle', async (req) => {
    const id = req.params.id;
    if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new ApiError(400, 'INVALID_PARAMETER', `"${id}" is not a market id (0x + 64 hex characters)`);
    const { block, asOf, number, timestamp } = await head();
    const market = await readMarket(reader, id.toLowerCase() as Hex, number);
    if (!market || market.collateral === zeroAddress) {
      throw new ApiError(404, 'MARKET_NOT_FOUND', `market ${id} does not exist or has no collateral (so no oracle)`);
    }
    const [collateral, loan, oracle] = await Promise.all([
      readToken(reader, market.collateral, number),
      readToken(reader, market.loan, number),
      decodeOracle(reader, market.oracle, number),
    ]);
    const a = deriveAssumption(market.collateral, oracle, registry);
    return {
      marketId: market.id,
      block,
      asOf,
      collateral: { address: market.collateral, symbol: collateral.symbol },
      loan: { symbol: loan.symbol },
      lltvPct: Number(market.lltv / 10n ** 14n) / 100,
      assumptionId: a.kind === 'assumption' ? a.id : null,
      assumption: a.kind === 'assumption' ? a.text : null,
      ...(a.kind === 'unknown' ? { unknown: { reasonCode: a.reasonCode, reason: a.reason } } : {}),
      oracle: oracleView(oracle),
      frozenFor: describeFrozenFor(frozenFor(oracle, registry, timestamp)),
      breakpoints: breakpoints(market.lltv),
    };
  });

  return app;
}
