import { describe, expect, it } from 'vitest';
import { createCoalescingMiddleware, stableStringify } from '../../../src/transport/coalesce.js';
import type { RpcTransport } from '../../../src/transport/types.js';
import { okResponse } from '../../helpers/mock-transport.js';

function countingTransport(delayMs = 5): {
  transport: RpcTransport;
  calls: number;
  abortedUnderlying: boolean;
} {
  const state = { calls: 0, abortedUnderlying: false };
  const transport = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    state.calls += 1;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      config.signal?.addEventListener('abort', () => {
        state.abortedUnderlying = true;
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
    return okResponse(state.calls);
  }) as RpcTransport;
  return Object.assign(state, { transport });
}

const payload = (method: string, params: unknown = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('createCoalescingMiddleware', () => {
  it('shares one underlying request among identical concurrent reads', async () => {
    const inner = countingTransport();
    const coalesced = createCoalescingMiddleware()(inner.transport);
    const [a, b, c] = await Promise.all([
      coalesced({ payload: payload('getSlot') }),
      coalesced({ payload: payload('getSlot') }),
      coalesced({ payload: payload('getSlot') }),
    ]);
    expect(inner.calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('separates requests with different params', async () => {
    const inner = countingTransport();
    const coalesced = createCoalescingMiddleware()(inner.transport);
    await Promise.all([
      coalesced({ payload: payload('getAccountInfo', ['addr1']) }),
      coalesced({ payload: payload('getAccountInfo', ['addr2']) }),
    ]);
    expect(inner.calls).toBe(2);
  });

  it('issues a fresh request after the previous one settles', async () => {
    const inner = countingTransport(1);
    const coalesced = createCoalescingMiddleware()(inner.transport);
    await coalesced({ payload: payload('getSlot') });
    await coalesced({ payload: payload('getSlot') });
    expect(inner.calls).toBe(2);
  });

  it('never coalesces sendTransaction', async () => {
    const inner = countingTransport(1);
    const coalesced = createCoalescingMiddleware()(inner.transport);
    await Promise.all([
      coalesced({ payload: payload('sendTransaction', ['AAA']) }),
      coalesced({ payload: payload('sendTransaction', ['AAA']) }),
    ]);
    expect(inner.calls).toBe(2);
  });

  it('keeps the shared request alive when only one subscriber aborts', async () => {
    const inner = countingTransport(20);
    const coalesced = createCoalescingMiddleware()(inner.transport);
    const aborter = new AbortController();
    const first = coalesced({ payload: payload('getSlot'), signal: aborter.signal });
    const second = coalesced({ payload: payload('getSlot') });
    const firstExpectation = expect(first).rejects.toThrow();
    aborter.abort();
    await firstExpectation;
    expect(await second).toEqual(okResponse(1));
    expect(inner.abortedUnderlying).toBe(false);
  });

  it('aborts the underlying request when every subscriber aborts', async () => {
    const inner = countingTransport(10_000);
    const coalesced = createCoalescingMiddleware()(inner.transport);
    const a = new AbortController();
    const b = new AbortController();
    const first = coalesced({ payload: payload('getSlot'), signal: a.signal });
    const second = coalesced({ payload: payload('getSlot'), signal: b.signal });
    const expectations = Promise.all([
      expect(first).rejects.toThrow(),
      expect(second).rejects.toThrow(),
    ]);
    a.abort();
    b.abort();
    await expectations;
    expect(inner.abortedUnderlying).toBe(true);
  });

  it('propagates shared failures to every subscriber', async () => {
    const failing = (async () => {
      throw new Error('node down');
    }) as RpcTransport;
    const coalesced = createCoalescingMiddleware()(failing);
    const results = await Promise.allSettled([
      coalesced({ payload: payload('getSlot') }),
      coalesced({ payload: payload('getSlot') }),
    ]);
    expect(results.every(r => r.status === 'rejected')).toBe(true);
  });
});

describe('stableStringify', () => {
  it('sorts object keys recursively and handles bigints', () => {
    expect(stableStringify({ b: 1, a: { d: 2n, c: 3 } })).toBe('{"a":{"c":3,"d":"2n"},"b":1}');
    expect(stableStringify([{ z: 1, y: 2 }])).toBe('[{"y":2,"z":1}]');
    expect(stableStringify(undefined)).toBe(undefined as unknown as string);
  });
});
