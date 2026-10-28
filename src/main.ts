import { loadRegistry } from './analysis/registry.js';
import { buildServer } from './api/server.js';
import { createViemReader } from './chain/reader.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db/pool.js';
import { createRepo } from './db/repo.js';
import { runIndexer } from './indexer/indexer.js';

const config = loadConfig(process.env);
const registry = loadRegistry('registry');
const reader = createViemReader(config.rpcUrl);

const pool = createPool(config.databaseUrl);
const applied = await migrate(pool);
if (applied.length > 0) console.log('migrations applied:', applied.join(', '));
const repo = createRepo(pool);

const app = buildServer({ reader, registry, vaults: config.vaults, repo, logger: true });
const stop = new AbortController();
const indexer = runIndexer(
  { reader, repo, registry },
  { vaults: config.vaults, confirmations: config.confirmations, backfillDays: config.backfillDays },
  stop.signal,
);

async function shutdown(signal: string) {
  console.log(`${signal}: shutting down`);
  stop.abort();
  await app.close();
  await indexer;
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: '0.0.0.0' });
