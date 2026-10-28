import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import type { Address } from '../types.js';

const feedSchema = z.object({
  description: z.string(),
  base: z.string(),
  quote: z.string(),
  type: z.enum(['market', 'exchange_rate']),
  deviationPct: z.number().positive().optional(),
  heartbeatSeconds: z.number().int().positive().optional(),
  source: z.string().optional(),
});
const tokenSchema = z.object({
  symbol: z.string(),
  peg: z.literal('USD').optional(),
  trivialWith: z.array(z.string()).optional(),
});

export type FeedInfo = z.infer<typeof feedSchema>;
export type TokenInfo = z.infer<typeof tokenSchema>;
export interface Registry {
  feeds: Map<Address, FeedInfo>;
  tokens: Map<Address, TokenInfo>;
}

function loadMap<T>(file: string, schema: z.ZodType<T>): Map<Address, T> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const out = new Map<Address, T>();
  for (const [key, value] of Object.entries(raw)) {
    if (!isAddress(key, { strict: false })) throw new Error(`${file}: key "${key}" is not an address`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error(`${file}: entry ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    out.set(getAddress(key) as Address, parsed.data);
  }
  return out;
}

// Reads registry/feeds.json and registry/tokens.json. A bad file stops the service at startup.
export function loadRegistry(dir: string): Registry {
  return {
    feeds: loadMap(join(dir, 'feeds.json'), feedSchema),
    tokens: loadMap(join(dir, 'tokens.json'), tokenSchema),
  };
}
