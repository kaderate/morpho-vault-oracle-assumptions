import {
  BaseError, BlockNotFoundError as ViemBlockNotFoundError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createPublicClient, ExecutionRevertedError,
  http, RawContractError, type Transport,
} from 'viem';
import { base } from 'viem/chains';
import type { Address, ChainReader, Hex } from '../types.js';
import { BlockNotFoundError, RpcUnavailableError } from './errors.js';

export interface ReaderOptions {
  concurrency?: number; // simultaneous RPC requests (Infura free tier answers 429 to bursts)
  retryCount?: number; // retries of a failed request (429, 5xx, network), exponential backoff
  retryDelay?: number; // base delay in ms
  multicall?: boolean; // batch same-tick eth_calls through Multicall3
  transport?: Transport; // tests only
}

// A revert means "this contract has no such function / the call failed": the caller gets null.
// Anything else (429 after retries, network down) is an outage and must throw, never look like a revert.
function isRevert(e: unknown): boolean {
  if (!(e instanceof BaseError)) return false;
  return (
    e.walk(
      (x) =>
        x instanceof ExecutionRevertedError ||
        x instanceof ContractFunctionRevertedError ||
        x instanceof ContractFunctionZeroDataError ||
        x instanceof RawContractError,
    ) !== null
  );
}

function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export function createViemReader(rpcUrl: string, opts: ReaderOptions = {}): ChainReader {
  const { concurrency = 3, retryCount = 5, retryDelay = 300, multicall = true } = opts;
  const limit = limiter(concurrency);
  const inner = opts.transport ?? http(rpcUrl, { retryCount, retryDelay });
  // The limit sits on the transport, below viem's Multicall3 batching: same-tick calls still merge into one request.
  const transport: Transport = (params) => {
    const t = inner(params);
    return { ...t, request: ((args: never, o: never) => limit(() => t.request(args, o))) as typeof t.request };
  };
  const client = createPublicClient({ chain: base, transport, batch: multicall ? { multicall: true } : undefined });

  // Anything that is not a revert is an outage: callers can tell "could not read" from "contract said no".
  async function guard<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ViemBlockNotFoundError) throw new BlockNotFoundError(`${what}: block not found`, { cause: e });
      if (e instanceof RpcUnavailableError || e instanceof BlockNotFoundError) throw e;
      throw new RpcUnavailableError(`${what}: ${(e as Error).message.split('\n')[0]}`, { cause: e });
    }
  }

  return {
    async call(to: Address, data: Hex, block?: bigint) {
      try {
        const r = await client.call({ to, data, ...(block !== undefined ? { blockNumber: block } : {}) });
        return (r.data ?? null) as Hex | null;
      } catch (e) {
        if (isRevert(e)) return null;
        return guard('eth_call', () => Promise.reject(e));
      }
    },
    blockNumber: () => guard('eth_blockNumber', () => client.getBlockNumber()),
    // One call for number and header: asking `blockNumber` then `getBlock(n)` can hit a node that is behind.
    latest: () =>
      guard('eth_getBlockByNumber(latest)', async () => {
        const b = await client.getBlock();
        return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
      }),
    block: (n: bigint) =>
      guard('eth_getBlockByNumber', async () => {
        const b = await client.getBlock({ blockNumber: n });
        return { number: b.number, hash: b.hash, timestamp: Number(b.timestamp) };
      }),
    async logs({ addresses, topics0, from, to }) {
      const logs = await guard('eth_getLogs', () =>
        client.request({
          method: 'eth_getLogs',
          params: [{ address: addresses, topics: [topics0], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        }),
      );
      return logs.map((l) => ({
        address: l.address,
        blockNumber: BigInt(l.blockNumber as Hex),
        txHash: l.transactionHash as Hex,
        logIndex: Number(l.logIndex),
      }));
    },
  };
}
