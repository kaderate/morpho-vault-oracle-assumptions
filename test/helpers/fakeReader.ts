import { encodeAbiParameters, encodeFunctionData, type Abi } from 'viem';
import type { Address, ChainReader, Hex } from '../../src/types.js';

export interface Fixture { block: string; calls: Record<string, string | null> }

const key = (to: string, data: string) => `${to.toLowerCase()}:${data}`;

// Serves recorded eth_call answers. A call that was not recorded is a revert (null), like an absent getter.
export function fakeReader(fixture: Fixture, overrides: Record<string, string | null> = {}): ChainReader {
  const calls = { ...fixture.calls, ...overrides };
  return {
    async call(to: Address, data: Hex) {
      return (calls[key(to, data)] as Hex | null | undefined) ?? null;
    },
    async blockNumber() { return BigInt(fixture.block); },
    async latest() { return this.block(BigInt(fixture.block)); },
    async block(n) { return { number: n, hash: '0x' + '00'.repeat(32) as Hex, timestamp: 1_700_000_000 }; },
    async logs() { return []; },
  };
}

// Builds the override entry for `fn()` on `to` answering `value` (an address, uint or bool).
export function answer(abi: Abi, to: Address, fn: string, type: 'address' | 'uint256' | 'bool', value: unknown) {
  const data = encodeFunctionData({ abi, functionName: fn } as never);
  return { [key(to, data)]: encodeAbiParameters([{ type }], [value as never]) as string };
}
