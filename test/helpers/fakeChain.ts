import { encodeFunctionData, encodeFunctionResult, type Abi } from 'viem';
import { BlockNotFoundError } from '../../src/chain/errors.js';
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

  /** Loads recorded eth_call answers (`<address lowercase>:<calldata>` → result), e.g. test/fixtures/oracles.json. */
  load(calls: Record<string, string | null>): this {
    for (const [k, v] of Object.entries(calls)) if (v !== null) this.answers.set(k, v as Hex);
    return this;
  }

  async call(to: Address, data: Hex, block?: bigint): Promise<Hex | null> {
    this.blocksSeen.add(block);
    return this.answers.get(`${to.toLowerCase()}:${data}`) ?? null;
  }
  /** Chain head, block hashes and timestamps: tests override these to move the head or fake a reorg. */
  head = 100n;
  hashOf = (_n: bigint): Hex => ('0x' + '11'.repeat(32)) as Hex;
  timestampOf = (_n: bigint) => 1_700_000_000;
  /** Logs the fake node knows about (topics are not filtered; tests read `logCalls` to check them). */
  logsList: { address: Address; blockNumber: bigint; txHash: Hex; logIndex: number }[] = [];
  readonly logCalls: { addresses: Address[]; topics0: Hex[]; from: bigint; to: bigint }[] = [];

  async blockNumber() { return this.head; }
  async latest() { return this.block(this.head); }
  async block(n: bigint) {
    if (n > this.head) throw new BlockNotFoundError(`block ${n} not found`);
    return { number: n, hash: this.hashOf(n), timestamp: this.timestampOf(n) };
  }
  async logs(p: { addresses: Address[]; topics0: Hex[]; from: bigint; to: bigint }) {
    this.logCalls.push(p);
    const wanted = new Set(p.addresses.map((a) => a.toLowerCase()));
    return this.logsList.filter((l) => wanted.has(l.address.toLowerCase()) && l.blockNumber >= p.from && l.blockNumber <= p.to);
  }
}
