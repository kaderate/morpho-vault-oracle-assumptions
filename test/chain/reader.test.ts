import { custom, HttpRequestError, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { BlockNotFoundError, RpcUnavailableError } from '../../src/chain/errors.js';
import { createViemReader } from '../../src/chain/reader.js';

const TO = '0x00000000000000000000000000000000000000a1';
const fast = { retryCount: 3, retryDelay: 1 };

function reader(request: (args: { method: string; params?: unknown }) => Promise<unknown>) {
  return createViemReader('http://unused', { multicall: false, transport: custom({ request: request as never }, fast), ...fast });
}

describe('createViemReader', () => {
  it('returns the call result', async () => {
    const r = reader(async () => '0x01');
    expect(await r.call(TO, '0x12345678')).toBe('0x01');
  });

  it('returns null on an execution revert and does not retry it', async () => {
    let calls = 0;
    const r = reader(async () => { calls++; throw new RpcRequestError({ body: {}, url: 'http://unused', error: { code: 3, message: 'execution reverted' } }); });
    expect(await r.call(TO, '0x12345678')).toBeNull();
    expect(calls).toBe(1);
  });

  it('retries a 429 and then succeeds', async () => {
    let calls = 0;
    const r = reader(async () => {
      calls++;
      if (calls < 3) throw new HttpRequestError({ url: 'http://unused', status: 429 });
      return '0x02';
    });
    expect(await r.call(TO, '0x12345678')).toBe('0x02');
    expect(calls).toBe(3);
  });

  it('throws when the transport keeps failing (never turns an outage into a revert)', async () => {
    const r = reader(async () => { throw new HttpRequestError({ url: 'http://unused', status: 503 }); });
    await expect(r.call(TO, '0x12345678')).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it('never runs more than `concurrency` requests at once', async () => {
    let active = 0, peak = 0;
    const r = createViemReader('http://unused', {
      concurrency: 2,
      multicall: false,
      transport: custom({ request: (async () => { active++; peak = Math.max(peak, active); await new Promise((x) => setTimeout(x, 5)); active--; return '0x01'; }) as never }, fast),
    });
    // distinct data so they cannot share a batch
    await Promise.all(Array.from({ length: 6 }, (_, i) => r.blockNumber().then(() => r.call(TO, `0x1234567${i}`))));
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('block() of a block that does not exist throws BlockNotFoundError', async () => {
    const r = reader(async () => null); // eth_getBlockByNumber answers null
    await expect(r.block(99_999_999_999n)).rejects.toBeInstanceOf(BlockNotFoundError);
  });

  it('latest() returns the head block header in one call', async () => {
    const r = reader(async () => ({
      number: '0x10', hash: `0x${'11'.repeat(32)}`, timestamp: '0x65', parentHash: `0x${'00'.repeat(32)}`, transactions: [], uncles: [],
    }));
    expect(await r.latest()).toEqual({ number: 16n, hash: `0x${'11'.repeat(32)}`, timestamp: 101 });
  });

  it('latest() failing surfaces as RpcUnavailableError', async () => {
    const r = reader(async () => { throw new HttpRequestError({ url: 'http://unused', status: 503 }); });
    await expect(r.latest()).rejects.toBeInstanceOf(RpcUnavailableError);
  });

  it('blockNumber() failing surfaces as RpcUnavailableError', async () => {
    const r = reader(async () => { throw new HttpRequestError({ url: 'http://unused', status: 503 }); });
    await expect(r.blockNumber()).rejects.toBeInstanceOf(RpcUnavailableError);
  });
});
