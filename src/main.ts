import { loadRegistry } from './analysis/registry.js';
import { buildServer } from './api/server.js';
import { createViemReader } from './chain/reader.js';
import { loadConfig } from './config.js';

const config = loadConfig(process.env);
const app = buildServer({
  reader: createViemReader(config.rpcUrl),
  registry: loadRegistry('registry'),
  vaults: config.vaults,
  logger: true,
});

await app.listen({ port: config.port, host: '0.0.0.0' });
