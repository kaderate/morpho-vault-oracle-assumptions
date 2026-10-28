import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const VAULT = '0xbeeff2490feffa212fac2f6553682c219e6a8845';
const CHECKSUM = '0xbeeff2490FEffa212faC2f6553682C219E6a8845';

describe('loadConfig', () => {
  it('parses a valid env and normalizes vault addresses to checksum', () => {
    const cfg = loadConfig({
      RPC_URL: 'https://base.example/key',
      VAULTS: `${VAULT}, ${CHECKSUM}`,
      DATABASE_URL: 'postgres://u:p@db:5432/x',
      PORT: '4000',
    });
    expect(cfg.rpcUrl).toBe('https://base.example/key');
    expect(cfg.vaults).toEqual([CHECKSUM, CHECKSUM]);
    expect(cfg.databaseUrl).toBe('postgres://u:p@db:5432/x');
    expect(cfg.port).toBe(4000);
  });

  it('throws an error mentioning RPC_URL when it is missing', () => {
    expect(() => loadConfig({ VAULTS: VAULT })).toThrow(/RPC_URL/);
  });

  it('lists every invalid variable', () => {
    expect(() => loadConfig({ VAULTS: 'nope', CONFIRMATIONS: 'x' })).toThrow(/RPC_URL[\s\S]*VAULTS[\s\S]*CONFIRMATIONS/);
  });

  it('defaults CONFIRMATIONS to 20 and BACKFILL_DAYS to 7', () => {
    const cfg = loadConfig({ RPC_URL: 'https://base.example/key', VAULTS: VAULT });
    expect(cfg.confirmations).toBe(20);
    expect(cfg.backfillDays).toBe(7);
    expect(cfg.port).toBe(3000);
    expect(cfg.databaseUrl).toBe('postgres://app:app@localhost:5433/oracle');
  });
});
