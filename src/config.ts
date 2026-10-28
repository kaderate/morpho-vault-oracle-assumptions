import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import type { Address } from './types.js';

export interface Config {
  rpcUrl: string;
  databaseUrl: string;
  vaults: Address[];
  confirmations: number;
  backfillDays: number;
  port: number;
}

const vaultList = z
  .string()
  .min(1, 'required')
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean))
  .pipe(
    z.array(z.string().refine((v) => isAddress(v, { strict: false }), 'not an address')).min(1, 'at least one vault'),
  )
  .transform((list) => list.map((v) => getAddress(v) as Address));

const int = (def: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a non-negative integer')
    .transform(Number)
    .optional()
    .transform((v) => v ?? def);

const schema = z.object({
  RPC_URL: z.string({ error: 'required' }).url('must be a URL'),
  VAULTS: vaultList,
  DATABASE_URL: z.string().default('postgres://app:app@localhost:5432/oracle'),
  CONFIRMATIONS: int(20),
  BACKFILL_DAYS: int(7),
  PORT: int(3000),
});

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    rpcUrl: e.RPC_URL,
    databaseUrl: e.DATABASE_URL,
    vaults: e.VAULTS,
    confirmations: e.CONFIRMATIONS,
    backfillDays: e.BACKFILL_DAYS,
    port: e.PORT,
  };
}
