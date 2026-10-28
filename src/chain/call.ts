import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import type { Address, ChainReader } from '../types.js';

// Typed eth_call through the ChainReader interface. null = the call reverted (or the getter does not exist).
export async function read<T>(
  reader: ChainReader,
  to: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[] = [],
  block?: bigint,
): Promise<T | null> {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const raw = await reader.call(to, data, block);
  if (raw === null || raw === '0x') return null;
  try {
    return decodeFunctionResult({ abi, functionName, data: raw } as never) as T;
  } catch {
    return null; // an answer that does not match the ABI is treated like a revert
  }
}
