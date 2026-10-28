import Fastify, { type FastifyInstance } from 'fastify';
import { getAddress, isAddress } from 'viem';
import { buildReport } from '../report.js';
import type { Registry } from '../analysis/registry.js';
import { BlockNotFoundError, RevertedError, RpcUnavailableError } from '../chain/errors.js';
import type { Repo } from '../db/repo.js';
import type { Address, ChainReader } from '../types.js';

export interface ServerDeps {
  reader: ChainReader;
  registry: Registry;
  vaults: Address[];
  repo: Repo;
  logger?: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { reader, registry, repo } = deps;
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
    // Database only: "current" is the latest stored snapshot, and block/asOf say which one. While the first
    // backfill is running that snapshot is old, and the response shows it.
    const [r, latest] = await Promise.all([repo.peaks(vault, days), repo.latestSnapshot(vault)]);
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

  return app;
}
