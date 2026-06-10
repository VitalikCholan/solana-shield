/**
 * Chaos scenario suite: the resilience layer exercised end-to-end against
 * hostile-network simulations. Every scenario is seeded → fully deterministic.
 */
import { describe, expect, it } from 'vitest';
import { createChaosTransport } from '../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../src/chaos/prng.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import { AllEndpointsFailedError } from '../../src/transport/types.js';
import { alwaysOk, createMockTransport, okResponse } from '../helpers/mock-transport.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };

describe('scenario: one degraded provider in a pool of three', () => {
  it('completes every request and shifts traffic off the degraded endpoint', async () => {
    const degraded = createChaosTransport(alwaysOk(1n), {
      seed: 42,
      dropRate: 0.7,
      httpErrors: [{ status: 502, rate: 0.2 }],
    });
    const healthyA = createMockTransport({ getSlot: 2n });
    const healthyB = createMockTransport({ getSlot: 3n });
    const { transport, health } = createResilientTransport({
      endpoints: [
        { id: 'degraded', url: 'https://x', transport: degraded },
        { id: 'a', url: 'https://a', transport: healthyA },
        { id: 'b', url: 'https://b', transport: healthyB },
      ],
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(7),
    });

    let failures = 0;
    for (let i = 0; i < 60; i++) {
      try {
        await transport({ payload: PAYLOAD });
      } catch {
        failures += 1;
      }
    }
    // Resilience: every logical request succeeds despite a 90%-broken endpoint.
    expect(failures).toBe(0);
    // Traffic steers away: the degraded endpoint sees far fewer calls than the healthy pool.
    const degradedShare =
      health.get('degraded')!.totalRequests /
      (health.get('a')!.totalRequests + health.get('b')!.totalRequests + health.get('degraded')!.totalRequests);
    expect(degradedShare).toBeLessThan(0.35);
    expect(health.get('degraded')!.score()).toBeLessThan(health.get('a')!.score());
  });
});

describe('scenario: rate-limit storm with Retry-After', () => {
  it('cools the throttled endpoint down and rides out the storm on the others', async () => {
    let time = 0;
    const now = () => time;
    const limited = createChaosTransport(
      alwaysOk(1n),
      { seed: 42, httpErrors: [{ status: 429, rate: 1, retryAfterMs: 5000 }] },
      { now },
    );
    const healthy = createMockTransport({ getSlot: 2n });
    const { transport, health } = createResilientTransport({
      endpoints: [
        { id: 'limited', url: 'https://x', transport: limited, weight: 100 }, // heavily preferred
        { id: 'healthy', url: 'https://y', transport: healthy },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(3),
      now,
    });

    await transport({ payload: PAYLOAD }); // hits limited (429) → rotates to healthy
    expect(health.get('limited')!.coolingDownForMs()).toBe(5000);

    // While cooling, every request goes straight to the healthy endpoint.
    const before = limited.stats.calls;
    for (let i = 0; i < 10; i++) await transport({ payload: PAYLOAD });
    expect(limited.stats.calls).toBe(before);

    // After Retry-After elapses the endpoint is eligible again.
    time += 5001;
    expect(health.get('limited')!.isAvailable()).toBe(true);
  });
});

describe('scenario: total partition, then recovery', () => {
  it('opens every breaker during the outage and recovers without deadlock', async () => {
    let time = 0;
    const now = () => time;
    const makeFlaky = () =>
      createChaosTransport(
        alwaysOk(1n),
        { seed: 42, dropRate: 1, schedule: [{ afterMs: 5000, plan: { dropRate: 0 } }] },
        { now },
      );
    const { transport, health } = createResilientTransport({
      endpoints: [
        { id: 'a', url: 'https://a', transport: makeFlaky() },
        { id: 'b', url: 'https://b', transport: makeFlaky() },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      breaker: { failureThreshold: 3, windowMs: 60_000, baseOpenMs: 1000, maxOpenMs: 8000, now },
      random: mulberry32(11),
      now,
    });

    // Hammer during the partition until both breakers open.
    let sawTotalFailure = false;
    for (let i = 0; i < 10; i++) {
      try {
        await transport({ payload: PAYLOAD });
      } catch (err) {
        sawTotalFailure = true;
        expect(err).toBeInstanceOf(AllEndpointsFailedError);
      }
    }
    expect(sawTotalFailure).toBe(true);
    expect(health.all().every(e => e.breaker.state() !== 'closed')).toBe(true);

    // Network heals.
    time += 5001;
    // The selector force-half-opens the best endpoint — no deadlock, service resumes.
    const response = await transport({ payload: PAYLOAD });
    expect(response).toEqual(okResponse(1n, 1));
    // Sustained success closes breakers again.
    for (let i = 0; i < 5; i++) await transport({ payload: PAYLOAD });
    expect(health.all().some(e => e.breaker.state() === 'closed')).toBe(true);
  });
});

describe('scenario: node-health errors steer reads to in-sync nodes', () => {
  it('retries node-behind responses on other endpoints transparently', async () => {
    const lagging = createChaosTransport(alwaysOk(1n), {
      seed: 42,
      rpcErrors: [{ code: -32005, message: 'Node is behind by 200 slots', rate: 1 }],
    });
    const synced = createMockTransport({ getSlot: 999n });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'lagging', url: 'https://x', transport: lagging, weight: 100 },
        { id: 'synced', url: 'https://y', transport: synced },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(5),
    });
    const response = await transport({ payload: PAYLOAD });
    expect(response).toEqual(okResponse(999n, 1));
  });
});

describe('scenario: deterministic replay', () => {
  it('produces identical outcome sequences for identical seeds', async () => {
    const run = async (): Promise<string[]> => {
      const chaos = createChaosTransport(alwaysOk(1n), {
        seed: 1337,
        dropRate: 0.4,
        httpErrors: [{ status: 503, rate: 0.2 }],
      });
      const { transport } = createResilientTransport({
        endpoints: [{ id: 'only', url: 'https://x', transport: chaos }],
        retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
        random: mulberry32(99),
      });
      const outcomes: string[] = [];
      for (let i = 0; i < 30; i++) {
        outcomes.push(
          await transport({ payload: PAYLOAD }).then(
            () => 'ok',
            (e: unknown) => (e instanceof AllEndpointsFailedError ? 'exhausted' : 'error'),
          ),
        );
      }
      return outcomes;
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toEqual(second);
    expect(first).toContain('ok');
    expect(first).toContain('exhausted');
  });
});
