import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import type { Address, ChainReader, Hex } from '../../src/types.js';

// Minimal live reader for the *.live.test.ts files (Task 6 adds the production reader).
export function liveReader(rpcUrl: string): ChainReader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  return {
    async call(to: Address, data: Hex, block?: bigint) {
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await client.call({ to, data, ...(block ? { blockNumber: block } : {}) });
          return (r.data ?? null) as Hex | null;
        } catch (e) {
          const msg = String((e as Error).message);
          if (/revert|execution/i.test(msg)) return null; // a real revert
          if (attempt >= 5) throw e; // transport error (429, network): retry, then fail loudly
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    },
    blockNumber: () => client.getBlockNumber(),
    async latest() {
      const b = await client.getBlock();
      return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
    },
    async block(n) {
      const b = await client.getBlock({ blockNumber: n });
      return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
    },
    async logs() { throw new Error('not used in live tests'); },
  };
}
