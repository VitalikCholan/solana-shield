import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHedgingMiddleware } from '../../../src/transport/hedge.js';
import type { RpcTransport } from '../../../src/transport/types.js';
import { okResponse } from '../../helpers/mock-transport.js';

const READ_PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };
const SEND_PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] };

afterEach(() => {
  vi.useRealTimers();
});

/** A transport whose nth call behaves per the given spec. */
function scriptedTransport(
  specs: Array<{ delayMs?: number; error?: Error; value?: unknown }>,
): { transport: RpcTransport; aborted: boolean[]; calls: number } {
  const state = { calls: 0, aborted: [] as boolean[] };
  const transport = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    const index = state.calls++;
    const spec = specs[Math.min(index, specs.length - 1)]!;
    state.aborted.push(false);
    if (spec.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, spec.delayMs);
        config.signal?.addEventListener('abort', () => {
          state.aborted[index] = true;
          clearTimeout(timer);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    }
    if (spec.error) throw spec.error;
    return spec.value ?? okResponse(index);
  }) as RpcTransport;
  return Object.assign(state, { transport });
}

describe('createHedgingMiddleware', () => {
  it('returns the primary response without hedging when it is fast', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([{ delayMs: 10, value: okResponse('fast') }]);
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toEqual(okResponse('fast'));
    expect(inner.calls).toBe(1);
  });

  it('fires a hedge after the delay and takes the faster result, aborting the loser', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([
      { delayMs: 10_000, value: okResponse('slow') },
      { delayMs: 10, value: okResponse('hedge') },
    ]);
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    await vi.advanceTimersByTimeAsync(150);
    expect(await pending).toEqual(okResponse('hedge'));
    expect(inner.calls).toBe(2);
    expect(inner.aborted[0]).toBe(true);
  });

  it('lets the primary win even after the hedge has fired', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([
      { delayMs: 150, value: okResponse('primary') },
      { delayMs: 10_000, value: okResponse('hedge') },
    ]);
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toEqual(okResponse('primary'));
    expect(inner.aborted[1]).toBe(true);
  });

  it('fires the hedge immediately if the primary fails before the delay', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([
      { delayMs: 10, error: new Error('primary down') },
      { delayMs: 10, value: okResponse('hedge') },
    ]);
    const hedged = createHedgingMiddleware({ delayMs: 5000 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toEqual(okResponse('hedge'));
  });

  it('rejects with the first error when both attempts fail', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([
      { delayMs: 10, error: new Error('first') },
      { delayMs: 10, error: new Error('second') },
    ]);
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    const expectation = expect(pending).rejects.toThrow('first');
    await vi.advanceTimersByTimeAsync(200);
    await expectation;
  });

  it('never hedges non-allowlisted methods', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([{ delayMs: 1000, value: okResponse('sent') }]);
    const hedged = createHedgingMiddleware({ delayMs: 10 })(inner.transport);
    const pending = hedged({ payload: SEND_PAYLOAD });
    await vi.advanceTimersByTimeAsync(1100);
    expect(await pending).toEqual(okResponse('sent'));
    expect(inner.calls).toBe(1);
  });

  it('aborts everything when the caller aborts', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([{ delayMs: 10_000 }]);
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner.transport);
    const controller = new AbortController();
    const pending = hedged({ payload: READ_PAYLOAD, signal: controller.signal });
    const expectation = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await expectation;
    expect(inner.aborted[0]).toBe(true);
  });

  it('supports a dynamic delay function', async () => {
    vi.useFakeTimers();
    const inner = scriptedTransport([
      { delayMs: 10_000, value: okResponse('slow') },
      { delayMs: 1, value: okResponse('hedge') },
    ]);
    const hedged = createHedgingMiddleware({ delayMs: () => 42 })(inner.transport);
    const pending = hedged({ payload: READ_PAYLOAD });
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toEqual(okResponse('hedge'));
  });
});
