import Fastify, { type FastifyInstance } from 'fastify';
import { getAddress, isAddress } from 'viem';
import { buildReport } from '../analysis/report.js';
import type { Registry } from '../analysis/registry.js';
import { readVaultMeta } from '../chain/vaultReader.js';
import type { Address, ChainReader } from '../types.js';

// What the API needs from the database. Task 7's Repo satisfies it.
export interface VaultsRepo {
  latestSnapshot(vault: Address): Promise<{ block: bigint } | null>;
}

export interface ServerDeps {
  reader: ChainReader;
  registry: Registry;
  vaults: Address[];
  repo?: VaultsRepo;
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
    const number = await reader.blockNumber();
    const header = await reader.block(number);
    return { block: Number(number), asOf: new Date(header.timestamp * 1000).toISOString(), number };
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
    return buildReport({ reader, registry }, vault, raw === undefined ? undefined : BigInt(raw));
  });

  return app;
}
