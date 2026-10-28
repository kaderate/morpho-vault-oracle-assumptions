import { getAddress, isAddress } from 'viem';
import type { Address } from './types.js';

export interface Config {
  rpcUrl: string;
  databaseUrl: string;
  vaults: Address[];
  confirmations: number;
  backfillDays: number;
  port: number;
}

// Reads the environment and reports every invalid variable at once, so one run fixes them all.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const errors: string[] = [];
  const int = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    if (!/^\d+$/.test(raw)) errors.push(`${name}: must be a non-negative integer, got "${raw}"`);
    return Number(raw);
  };

  const rpcUrl = env.RPC_URL ?? '';
  if (!URL.canParse(rpcUrl)) errors.push('RPC_URL: required, must be a URL');

  const listed = (env.VAULTS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
  if (listed.length === 0) errors.push('VAULTS: required, comma-separated vault addresses');
  const bad = listed.filter((v) => !isAddress(v, { strict: false }));
  if (bad.length > 0) errors.push(`VAULTS: not an address: ${bad.join(', ')}`);

  const confirmations = int('CONFIRMATIONS', 20);
  const backfillDays = int('BACKFILL_DAYS', 7);
  const port = int('PORT', 3000);

  if (errors.length > 0) throw new Error(`Invalid configuration:\n${errors.join('\n')}`);
  return {
    rpcUrl,
    databaseUrl: env.DATABASE_URL || 'postgres://app:app@localhost:5433/oracle',
    vaults: listed.map((v) => getAddress(v) as Address),
    confirmations,
    backfillDays,
    port,
  };
}
