import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// `schema` isolates a pool in its own search_path (used by tests so they never touch real data).
export function createPool(connectionString: string, schema?: string): pg.Pool {
  return new pg.Pool({ connectionString, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

// Applies db/migrations/*.sql in name order, once each. Each file runs in its own transaction.
export async function migrate(pool: pg.Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const done = new Set((await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (e) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
