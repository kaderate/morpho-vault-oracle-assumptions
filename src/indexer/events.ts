import { toEventSelector } from 'viem';
import type { Hex } from '../types.js';

// V2 vault: signatures from morpho-org/vault-v2 EventsLib; Allocate/Deallocate selectors also seen on Base.
export const V2_TOPICS: Hex[] = [
  'Allocate(address,address,uint256,bytes32[],int256)',
  'Deallocate(address,address,uint256,bytes32[],int256)',
  'ForceDeallocate(address,address,uint256,address,bytes32[],uint256)',
].map((s) => toEventSelector(s));

// V1 vault behind a MorphoVaultV1Adapter. Reallocate* only fire in reallocate(); user deposits and
// withdrawals move the same Morpho positions, so the ERC4626 events are needed too.
export const V1_TOPICS: Hex[] = [
  'ReallocateSupply(address,bytes32,uint256,uint256)',
  'ReallocateWithdraw(address,bytes32,uint256,uint256)',
  'Deposit(address,address,uint256,uint256)',
  'Withdraw(address,address,address,uint256,uint256)',
].map((s) => toEventSelector(s));

// Cost control: at most one block per time window. The first and last of the input are always kept,
// so the start and the end of a range are never lost. Input may be unsorted or have duplicates.
export function coalesceBlocks(blocks: { number: bigint; timestamp: number }[], windowSeconds: number): bigint[] {
  const unique = [...new Map(blocks.map((b) => [b.number, b])).values()].sort((a, b) => (a.number < b.number ? -1 : 1));
  if (unique.length === 0) return [];
  const kept = [unique[0]!];
  for (const b of unique.slice(1, -1)) {
    if (b.timestamp - kept[kept.length - 1]!.timestamp >= windowSeconds) kept.push(b);
  }
  if (unique.length > 1) kept.push(unique[unique.length - 1]!);
  return kept.map((b) => b.number);
}
