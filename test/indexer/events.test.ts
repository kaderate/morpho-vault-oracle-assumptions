import { describe, expect, it } from 'vitest';
import { coalesceBlocks, V1_TOPICS, V2_TOPICS } from '../../src/indexer/events.js';

const b = (number: number, timestamp: number) => ({ number: BigInt(number), timestamp });

describe('coalesceBlocks', () => {
  it('keeps one block per window and always the first and the last', () => {
    const blocks = [b(1, 0), b(2, 100), b(3, 200), b(4, 700), b(5, 800), b(6, 1300)];
    expect(coalesceBlocks(blocks, 600)).toEqual([1n, 4n, 6n]);
  });

  it('keeps both ends even when they fall in the same window', () => {
    expect(coalesceBlocks([b(1, 0), b(2, 50)], 600)).toEqual([1n, 2n]);
  });

  it('handles one block and no block', () => {
    expect(coalesceBlocks([b(7, 5)], 600)).toEqual([7n]);
    expect(coalesceBlocks([], 600)).toEqual([]);
  });

  it('sorts and de-duplicates its input', () => {
    expect(coalesceBlocks([b(3, 900), b(1, 0), b(3, 900), b(2, 10)], 600)).toEqual([1n, 3n]);
  });
});

describe('event topics', () => {
  it('V2 vault: Allocate, Deallocate, ForceDeallocate (selectors checked on Base)', () => {
    expect(V2_TOPICS).toHaveLength(3);
    expect(V2_TOPICS.map((t) => t.slice(0, 10))).toEqual(expect.arrayContaining(['0x2bc7948a', '0xd602b36f']));
  });

  it('V1 vault: ReallocateSupply, ReallocateWithdraw and the ERC4626 Deposit and Withdraw', () => {
    expect(V1_TOPICS).toHaveLength(4);
    expect(V1_TOPICS.map((t) => t.slice(0, 10))).toEqual(expect.arrayContaining(['0xdcbc1c05', '0xfbde797d']));
  });
});
