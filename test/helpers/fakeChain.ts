import { encodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import type { Address, ChainReader, Hex } from '../../src/types.js';

// Tiny contract simulator: register what `fn(args)` returns on an address; everything else reverts (null).
export class FakeChain implements ChainReader {
  private answers = new Map<string, Hex>();
  /** Block parameter of every call received (undefined = `latest`). */
  readonly blocksSeen = new Set<bigint | undefined>();

  on(to: Address, abi: Abi, fn: string, args: readonly unknown[], result: unknown): this {
    const data = encodeFunctionData({ abi, functionName: fn, args } as never);
    const out = encodeFunctionResult({ abi, functionName: fn, result } as never);
    this.answers.set(`${to.toLowerCase()}:${data}`, out);
    return this;
  }

  async call(to: Address, data: Hex, block?: bigint): Promise<Hex | null> {
    this.blocksSeen.add(block);
    return this.answers.get(`${to.toLowerCase()}:${data}`) ?? null;
  }
  async blockNumber() { return 100n; }
  async block(n: bigint) { return { number: n, hash: ('0x' + '11'.repeat(32)) as Hex, timestamp: 1_700_000_000 }; }
  async logs() { return []; }
}
