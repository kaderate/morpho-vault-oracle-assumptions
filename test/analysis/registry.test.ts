import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../../src/analysis/registry.js';

describe('loadRegistry', () => {
  it('loads the repo registry', () => {
    const r = loadRegistry('registry');
    expect(r.feeds.get('0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F')).toMatchObject({ base: 'BTC', quote: 'USD', type: 'market' });
    expect(r.tokens.get('0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34')).toMatchObject({ symbol: 'USDe', peg: 'USD' });
  });

  it('normalizes lowercase addresses to checksum', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    writeFileSync(join(dir, 'feeds.json'), JSON.stringify({
      '0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f': { description: 'BTC / USD', base: 'BTC', quote: 'USD', type: 'market' },
    }));
    writeFileSync(join(dir, 'tokens.json'), '{}');
    expect([...loadRegistry(dir).feeds.keys()]).toEqual(['0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F']);
  });

  it('rejects an entry with an unknown feed type, naming the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    writeFileSync(join(dir, 'feeds.json'), JSON.stringify({
      '0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F': { description: 'x', base: 'BTC', quote: 'USD', type: 'guess' },
    }));
    writeFileSync(join(dir, 'tokens.json'), '{}');
    expect(() => loadRegistry(dir)).toThrow(/feeds\.json/);
  });

  it('rejects a key that is not an address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-'));
    writeFileSync(join(dir, 'feeds.json'), '{}');
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ nope: { symbol: 'X', underlying: 'X' } }));
    expect(() => loadRegistry(dir)).toThrow(/tokens\.json.*nope/);
  });
});
