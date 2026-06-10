import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChaosTransport } from '../../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../../src/chaos/prng.js';
import { scenarios } from '../../../src/chaos/scenarios.js';
import { classifyFailure, classifyRpcErrorResponse } from '../../../src/transport/classify.js';
import { alwaysOk } from '../../helpers/mock-transport.js';

const PAYLOAD = { jsonrpc: '2.0', id: 9, method: 'getSlot', params: [] };

afterEach(() => {
  vi.useRealTimers();
});

async function outcomes(transportFactory: () => ReturnType<typeof createChaosTransport>, n: number) {
  const transport = transportFactory();
  const results: string[] = [];
  for (let i = 0; i < n; i++) {
    try {
      const response = await transport({ payload: PAYLOAD });
      results.push(classifyRpcErrorResponse(response) ? 'rpc-error' : 'ok');
    } catch (err) {
      results.push(classifyFailure(err).kind);
    }
  }
  return results;
}

describe('createChaosTransport', () => {
  it('is fully deterministic for a given seed', async () => {
    const factory = () =>
      createChaosTransport(alwaysOk(), {
        seed: 1234,
        dropRate: 0.3,
        httpErrors: [{ status: 429, rate: 0.2 }],
        rpcErrors: [{ code: -32005, message: 'behind', rate: 0.2 }],
      });
    const run1 = await outcomes(factory, 50);
    const run2 = await outcomes(factory, 50);
    expect(run1).toEqual(run2);
    expect(new Set(run1).size).toBeGreaterThan(1); // actually mixes outcomes
  });

  it('produces different sequences for different seeds', async () => {
    const run1 = await outcomes(() => createChaosTransport(alwaysOk(), { seed: 1, dropRate: 0.5 }), 40);
    const run2 = await outcomes(() => createChaosTransport(alwaysOk(), { seed: 2, dropRate: 0.5 }), 40);
    expect(run1).not.toEqual(run2);
  });

  it('drops requests with a network-shaped error', async () => {
    const transport = createChaosTransport(alwaysOk(), { seed: 1, dropRate: 1 });
    const err = await transport({ payload: PAYLOAD }).catch(e => e);
    const classified = classifyFailure(err);
    expect(classified.kind).toBe('network');
    expect(classified.retryable).toBe(true);
    expect(transport.stats.dropped).toBe(1);
  });

  it('injects HTTP errors that classify exactly like kit transport errors', async () => {
    const transport = createChaosTransport(alwaysOk(), {
      seed: 1,
      httpErrors: [{ status: 429, rate: 1, retryAfterMs: 3000 }],
    });
    const err = await transport({ payload: PAYLOAD }).catch(e => e);
    const classified = classifyFailure(err);
    expect(classified).toMatchObject({ kind: 'http', httpStatus: 429, retryable: true });
    expect(classified.cooldownMs).toBe(3000);
    expect(transport.stats.injectedHttpErrors).toBe(1);
  });

  it('returns JSON-RPC error envelopes (not throws) for rpcErrors', async () => {
    const transport = createChaosTransport(alwaysOk(), {
      seed: 1,
      rpcErrors: [{ code: -32005, message: 'Node is behind', rate: 1 }],
    });
    const response = await transport({ payload: PAYLOAD });
    expect(response).toMatchObject({ jsonrpc: '2.0', id: 9, error: { code: -32005 } });
    expect(classifyRpcErrorResponse(response)?.rotateEndpoint).toBe(true);
  });

  it('scopes rpcErrors to specific methods', async () => {
    const transport = createChaosTransport(alwaysOk('fine'), {
      seed: 1,
      rpcErrors: [{ code: -32005, message: 'behind', rate: 1, methods: ['sendTransaction'] }],
    });
    const response = await transport({ payload: PAYLOAD });
    expect(response).toMatchObject({ result: 'fine' });
  });

  it('adds latency before completing', async () => {
    vi.useFakeTimers();
    const transport = createChaosTransport(alwaysOk(), {
      seed: 1,
      latency: { meanMs: 500, distribution: 'fixed' },
    });
    let settled = false;
    const pending = transport({ payload: PAYLOAD }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await pending;
    expect(settled).toBe(true);
  });

  it('supports normal and pareto latency distributions', async () => {
    vi.useFakeTimers();
    for (const distribution of ['normal', 'pareto'] as const) {
      const transport = createChaosTransport(alwaysOk(), {
        seed: 3,
        latency: { meanMs: 100, distribution },
      });
      const pending = transport({ payload: PAYLOAD });
      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBeDefined();
    }
  });

  it('hangs slow-loris requests until the hang elapses', async () => {
    vi.useFakeTimers();
    const transport = createChaosTransport(alwaysOk(), {
      seed: 1,
      slowLoris: { rate: 1, hangMs: 10_000 },
    });
    let settled = false;
    const pending = transport({ payload: PAYLOAD }).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    await pending;
    expect(transport.stats.slowLorisHangs).toBe(1);
  });

  it('flaps between up and down windows on the injected clock', async () => {
    let time = 0;
    const transport = createChaosTransport(
      alwaysOk(),
      { seed: 1, flapping: { upMs: 1000, downMs: 500 } },
      { now: () => time },
    );
    await expect(transport({ payload: PAYLOAD })).resolves.toBeDefined();
    time = 1200; // inside the down window
    await expect(transport({ payload: PAYLOAD })).rejects.toThrow(/chaos/);
    time = 1600; // back up (cycle length 1500)
    await expect(transport({ payload: PAYLOAD })).resolves.toBeDefined();
    expect(transport.stats.flappingDrops).toBe(1);
  });

  it('applies scheduled phases over the base plan', async () => {
    let time = 0;
    const transport = createChaosTransport(
      alwaysOk(),
      { seed: 1, dropRate: 1, schedule: [{ afterMs: 5000, plan: { dropRate: 0 } }] },
      { now: () => time },
    );
    await expect(transport({ payload: PAYLOAD })).rejects.toThrow();
    time = 5001;
    await expect(transport({ payload: PAYLOAD })).resolves.toBeDefined();
  });

  it('setPlan replaces the active plan and reseeds', async () => {
    const transport = createChaosTransport(alwaysOk(), { seed: 1, dropRate: 1 });
    await expect(transport({ payload: PAYLOAD })).rejects.toThrow();
    transport.setPlan({ seed: 9, dropRate: 0 });
    await expect(transport({ payload: PAYLOAD })).resolves.toBeDefined();
    expect(transport.stats.calls).toBe(2);
  });

  it('ships ready-made scenarios that parse as valid plans', async () => {
    for (const plan of Object.values(scenarios)) {
      expect(typeof plan.seed).toBe('number');
    }
    // laggingNode actually produces node-health errors.
    const transport = createChaosTransport(alwaysOk(), scenarios.laggingNode);
    const results = await outcomes(() => transport, 20);
    expect(results).toContain('rpc-error');
  });
});

describe('mulberry32', () => {
  it('produces a stable sequence in [0, 1)', () => {
    const random = mulberry32(99);
    const seq = [random(), random(), random()];
    const random2 = mulberry32(99);
    expect([random2(), random2(), random2()]).toEqual(seq);
    for (const v of seq) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
