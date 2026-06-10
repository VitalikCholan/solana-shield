import { afterEach, describe, expect, it, vi } from 'vitest';
import { composeTransport, createResilientTransport } from '../../../src/transport/stack.js';
import type { RpcTransport } from '../../../src/transport/types.js';
import { AllEndpointsFailedError } from '../../../src/transport/types.js';
import { alwaysOk, createMockTransport, okResponse, rpcErrorResponse } from '../../helpers/mock-transport.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };

function networkError(): Error {
  return Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { context: { statusCode: status } });
}

function make(
  transports: RpcTransport[],
  options: Partial<Parameters<typeof createResilientTransport>[0]> = {},
) {
  return createResilientTransport({
    endpoints: transports.map((transport, i) => ({
      id: `ep-${i}`,
      url: `https://rpc-${i}.example.com`,
      transport,
    })),
    random: () => 0, // deterministic selection (first candidate) and zero backoff
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    ...options,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createResilientTransport', () => {
  it('returns the response from a healthy endpoint', async () => {
    const mock = createMockTransport({ getSlot: 123 });
    const { transport, health } = make([mock]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(okResponse(123, 1));
    expect(health.get('ep-0')!.totalRequests).toBe(1);
    expect(health.get('ep-0')!.totalFailures).toBe(0);
  });

  it('fails over to the next endpoint on a network error', async () => {
    const bad = createMockTransport({
      getSlot: () => {
        throw networkError();
      },
    });
    const good = createMockTransport({ getSlot: 456 });
    const { transport, health } = make([bad, good]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(okResponse(456, 1));
    expect(bad.calls).toHaveLength(1);
    expect(good.calls).toHaveLength(1);
    expect(health.get('ep-0')!.totalFailures).toBe(1);
  });

  it('rotates away from node-health RPC errors and returns the last error envelope when exhausted', async () => {
    const behind = rpcErrorResponse(-32005, 'Node is behind by 100 slots');
    const a = createMockTransport({ getSlot: () => behind });
    const b = createMockTransport({ getSlot: () => behind });
    const { transport, health } = make([a, b]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(behind);
    // 3 attempts spread across 2 endpoints.
    expect(a.calls.length + b.calls.length).toBe(3);
    expect(health.all().every(e => e.totalFailures >= 1)).toBe(true);
  });

  it('passes application-level RPC errors straight through without retrying', async () => {
    const appError = rpcErrorResponse(-32602, 'Invalid params');
    const mock = createMockTransport({ getSlot: () => appError });
    const { transport } = make([mock, createMockTransport({ getSlot: 1 })]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(appError);
    expect(mock.calls).toHaveLength(1);
  });

  it('rethrows non-retryable client errors immediately', async () => {
    const mock = createMockTransport({
      getSlot: () => {
        throw httpError(400);
      },
    });
    const fallback = createMockTransport({ getSlot: 1 });
    const { transport } = make([mock, fallback]);
    await expect(transport({ payload: PAYLOAD })).rejects.toThrow('HTTP 400');
    expect(fallback.calls).toHaveLength(0);
  });

  it('marks an endpoint dead on 403 but still completes on another endpoint', async () => {
    const forbidden = createMockTransport({
      getSlot: () => {
        throw httpError(403);
      },
    });
    const good = createMockTransport({ getSlot: 789 });
    const { transport, health } = make([forbidden, good]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(okResponse(789, 1));
    expect(health.get('ep-0')!.dead).toBe(true);
    expect(health.get('ep-0')!.deadReason).toMatch(/403/);
  });

  it('throws the 403 when no other live endpoint exists', async () => {
    const forbidden = createMockTransport({
      getSlot: () => {
        throw httpError(403);
      },
    });
    const { transport } = make([forbidden]);
    await expect(transport({ payload: PAYLOAD })).rejects.toThrow('HTTP 403');
  });

  it('respects caller aborts without penalizing endpoints', async () => {
    const controller = new AbortController();
    controller.abort();
    const mock = createMockTransport({ getSlot: 1 });
    const { transport, health } = make([mock]);
    await expect(transport({ payload: PAYLOAD, signal: controller.signal })).rejects.toThrow();
    expect(mock.calls).toHaveLength(0);
    expect(health.get('ep-0')!.totalRequests).toBe(0);
  });

  it('aborts mid-flight when the caller cancels', async () => {
    const controller = new AbortController();
    const hanging = ((config: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        config.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as RpcTransport;
    const { transport, health } = make([hanging]);
    const pending = transport({ payload: PAYLOAD, signal: controller.signal });
    const expectation = expect(pending).rejects.toThrow('aborted');
    controller.abort();
    await expectation;
    expect(health.get('ep-0')!.totalFailures).toBe(0);
  });

  it('times out a hanging endpoint and fails over', async () => {
    vi.useFakeTimers();
    const hanging = ((config: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        config.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as RpcTransport;
    const good = createMockTransport({ getSlot: 42 });
    const { transport, health } = make([hanging, good], { requestTimeoutMs: 50 });
    const pending = transport({ payload: PAYLOAD });
    await vi.advanceTimersByTimeAsync(60);
    await expect(pending).resolves.toEqual(okResponse(42, 1));
    expect(health.get('ep-0')!.totalFailures).toBe(1);
    expect(health.get('ep-0')!.lastFailure).toMatch(/aborted|timed out/i);
  });

  it('throws AllEndpointsFailedError carrying every classified failure', async () => {
    const failing = () =>
      createMockTransport({
        getSlot: () => {
          throw networkError();
        },
      });
    const { transport } = make([failing(), failing()]);
    const err = await transport({ payload: PAYLOAD }).catch(e => e);
    expect(err).toBeInstanceOf(AllEndpointsFailedError);
    expect((err as AllEndpointsFailedError).failures).toHaveLength(3);
    expect((err as AllEndpointsFailedError).message).toMatch(/3 attempts/);
  });

  it('cools down a 429 endpoint and avoids it on the next request', async () => {
    const limited = createMockTransport({
      getSlot: (_params: unknown, i: number) => {
        if (i === 0) throw Object.assign(httpError(429), { context: { statusCode: 429, headers: { 'retry-after': '5' } } });
        return 1;
      },
    });
    const good = createMockTransport({ getSlot: 2 });
    const { transport, health } = make([limited, good]);
    await expect(transport({ payload: PAYLOAD })).resolves.toEqual(okResponse(2, 1));
    expect(health.get('ep-0')!.coolingDownForMs()).toBeGreaterThan(4000);
    // Next request goes straight to the healthy endpoint.
    await transport({ payload: PAYLOAD });
    expect(limited.calls).toHaveLength(1);
    expect(good.calls).toHaveLength(2);
  });

  it('waits for a rate-cap token instead of bursting past the configured rps', async () => {
    vi.useFakeTimers();
    const mock = createMockTransport({ getSlot: 1 });
    const { transport } = createResilientTransport({
      endpoints: [{ id: 'ep-0', url: 'https://x', transport: mock, rps: 1 }],
      random: () => 0,
    });
    await transport({ payload: PAYLOAD });
    const second = transport({ payload: PAYLOAD });
    let settled = false;
    void second.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await second;
    expect(mock.calls).toHaveLength(2);
  });

  it('records logical request metrics', async () => {
    const mock = createMockTransport({ getSlot: 1 });
    const { transport, metrics } = make([mock]);
    await transport({ payload: PAYLOAD });
    expect(
      metrics.getCounter('solana_shield.rpc.logical_request.count', {
        method: 'getSlot',
        outcome: 'success',
      }),
    ).toBe(1);
  });
});

describe('composeTransport', () => {
  it('applies middlewares with the first as outermost', async () => {
    const order: string[] = [];
    const base = alwaysOk('base');
    const mw = (label: string) => (next: RpcTransport) =>
      (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
        order.push(`before:${label}`);
        const result = await next(config);
        order.push(`after:${label}`);
        return result;
      }) as RpcTransport;
    const composed = composeTransport(base, mw('outer'), mw('inner'));
    await composed({ payload: PAYLOAD });
    expect(order).toEqual(['before:outer', 'before:inner', 'after:inner', 'after:outer']);
  });
});
