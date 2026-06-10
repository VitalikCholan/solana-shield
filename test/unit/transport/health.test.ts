import { describe, expect, it } from 'vitest';
import { MetricsRegistry } from '../../../src/telemetry/registry.js';
import type { EndpointInit } from '../../../src/transport/health.js';
import { HealthRegistry, defaultScore } from '../../../src/transport/health.js';
import type { ClassifiedFailure } from '../../../src/transport/types.js';
import { alwaysOk } from '../../helpers/mock-transport.js';

function makeRegistry(inits?: Partial<EndpointInit>[], time = { value: 0 }) {
  const metrics = new MetricsRegistry();
  const endpoints = (inits ?? [{}]).map((init, i) => ({
    id: init.id ?? `ep-${i}`,
    url: init.url ?? `https://rpc-${i}.example.com`,
    transport: init.transport ?? alwaysOk(),
    ...(init.label !== undefined ? { label: init.label } : {}),
    ...(init.weight !== undefined ? { weight: init.weight } : {}),
    ...(init.rps !== undefined ? { rps: init.rps } : {}),
  }));
  const registry = new HealthRegistry(endpoints, { metrics, now: () => time.value });
  return { registry, metrics, time };
}

function failure(overrides: Partial<ClassifiedFailure> = {}): ClassifiedFailure {
  return {
    kind: 'network',
    retryable: true,
    rotateEndpoint: true,
    markDead: false,
    message: 'fetch failed',
    cause: undefined,
    ...overrides,
  };
}

describe('defaultScore', () => {
  it('is 1-ish for a perfect endpoint and decays with latency', () => {
    expect(defaultScore({ latencyEwmaMs: 0, errorRateEwma: 0, slotLag: 0 })).toBe(1);
    const slow = defaultScore({ latencyEwmaMs: 1000, errorRateEwma: 0, slotLag: 0 });
    expect(slow).toBeLessThan(1);
    expect(slow).toBeGreaterThan(0.3);
  });

  it('punishes error rate much harder than latency (reliability cubed)', () => {
    const flaky = defaultScore({ latencyEwmaMs: 50, errorRateEwma: 0.5, slotLag: 0 });
    const slow = defaultScore({ latencyEwmaMs: 1500, errorRateEwma: 0, slotLag: 0 });
    expect(flaky).toBeLessThan(slow);
  });

  it('never returns zero (keeps weighted sampling well-defined)', () => {
    expect(defaultScore({ latencyEwmaMs: 99_999, errorRateEwma: 1, slotLag: 999 })).toBeGreaterThan(0);
  });
});

describe('EndpointState', () => {
  it('seeds the latency EWMA with the first sample, then smooths', () => {
    const { registry } = makeRegistry();
    const ep = registry.all()[0]!;
    ep.recordSuccess(100, 'getSlot');
    expect(ep.latencyEwmaMs).toBe(100);
    ep.recordSuccess(200, 'getSlot');
    expect(ep.latencyEwmaMs).toBeCloseTo(120); // 100 + 0.2 * (200 - 100)
  });

  it('drives error EWMA up on failures and decays it on success', () => {
    const { registry } = makeRegistry();
    const ep = registry.all()[0]!;
    ep.recordFailure(failure(), 50, 'getSlot');
    expect(ep.errorRateEwma).toBeCloseTo(0.1);
    ep.recordFailure(failure(), 50, 'getSlot');
    expect(ep.errorRateEwma).toBeCloseTo(0.19);
    ep.recordSuccess(50, 'getSlot');
    expect(ep.errorRateEwma).toBeCloseTo(0.171);
  });

  it('marks dead on markDead failures and revives on demand', () => {
    const { registry } = makeRegistry();
    const ep = registry.all()[0]!;
    ep.recordFailure(failure({ markDead: true, message: 'HTTP 403' }), 10, 'getSlot');
    expect(ep.dead).toBe(true);
    expect(ep.deadReason).toBe('HTTP 403');
    expect(ep.isAvailable()).toBe(false);
    ep.revive();
    expect(ep.isAvailable()).toBe(true);
  });

  it('applies rate-limit cooldowns (escalating without Retry-After)', () => {
    const time = { value: 0 };
    const { registry } = makeRegistry(undefined, time);
    const ep = registry.all()[0]!;
    ep.recordFailure(failure({ kind: 'http', httpStatus: 429, message: 'HTTP 429 (rate limited)' }), 5, 'getSlot');
    expect(ep.isAvailable()).toBe(false);
    expect(ep.coolingDownForMs()).toBe(1000);
    time.value += 1001;
    expect(ep.isAvailable()).toBe(true);
    // Second consecutive 429 → 2s.
    ep.recordFailure(failure({ kind: 'http', httpStatus: 429, message: 'HTTP 429 (rate limited)' }), 5, 'getSlot');
    expect(ep.coolingDownForMs()).toBe(2000);
  });

  it('honors explicit Retry-After cooldowns', () => {
    const time = { value: 0 };
    const { registry } = makeRegistry(undefined, time);
    const ep = registry.all()[0]!;
    ep.recordFailure(
      failure({ kind: 'http', httpStatus: 429, cooldownMs: 7000, message: 'HTTP 429 (rate limited)' }),
      5,
      'getSlot',
    );
    expect(ep.coolingDownForMs()).toBe(7000);
  });

  it('applies cooldowns from non-429 failures too', () => {
    const time = { value: 0 };
    const { registry } = makeRegistry(undefined, time);
    const ep = registry.all()[0]!;
    ep.recordFailure(failure({ cooldownMs: 1234, message: 'node syncing' }), 5, 'getSlot');
    expect(ep.coolingDownForMs()).toBe(1234);
  });

  it('is unavailable while its breaker is open', () => {
    const { registry } = makeRegistry();
    const ep = registry.all()[0]!;
    for (let i = 0; i < 5; i++) ep.recordFailure(failure(), 5, 'getSlot');
    expect(ep.breaker.state()).toBe('open');
    expect(ep.isAvailable()).toBe(false);
  });

  it('respects a proactive rps cap', () => {
    const { registry } = makeRegistry([{ rps: 1 }]);
    const ep = registry.all()[0]!;
    expect(ep.isAvailable()).toBe(true);
    ep.bucket!.tryRemove();
    expect(ep.isAvailable()).toBe(false);
  });

  it('produces a complete snapshot', () => {
    const { registry } = makeRegistry([{ label: 'primary' }]);
    const ep = registry.all()[0]!;
    ep.recordSuccess(100, 'getSlot');
    ep.recordFailure(failure(), 200, 'getSlot');
    const snap = ep.snapshot();
    expect(snap).toMatchObject({
      label: 'primary',
      dead: false,
      breakerState: 'closed',
      totalRequests: 2,
      totalFailures: 1,
      lastFailure: 'fetch failed',
    });
    expect(snap.p50Ms).toBeGreaterThan(0);
    expect(snap.score).toBeGreaterThan(0);
  });
});

describe('HealthRegistry', () => {
  it('rejects duplicate ids and empty endpoint lists', () => {
    const metrics = new MetricsRegistry();
    expect(() => new HealthRegistry([], { metrics })).toThrow(/at least one/i);
    const init = { id: 'a', url: 'https://x', transport: alwaysOk() };
    expect(() => new HealthRegistry([init, init], { metrics })).toThrow(/duplicate/i);
  });

  it('filters available endpoints', () => {
    const { registry } = makeRegistry([{}, {}]);
    const [a] = registry.all();
    a!.recordFailure(failure({ markDead: true }), 5, 'getSlot');
    expect(registry.available().map(e => e.id)).toEqual(['ep-1']);
  });

  it('computes slot lag relative to the most advanced endpoint', () => {
    const { registry, metrics } = makeRegistry([{}, {}, {}]);
    registry.recordSlots(
      new Map([
        ['ep-0', 1000n],
        ['ep-1', 990n],
        ['ep-2', 1000n],
      ]),
    );
    expect(registry.get('ep-0')!.slotLag).toBe(0);
    expect(registry.get('ep-1')!.slotLag).toBe(10);
    expect(metrics.getGauge('solana_shield.endpoint.slot_lag', { endpoint: 'ep-1' })).toBe(10);
  });

  it('exposes snapshots for every endpoint', () => {
    const { registry } = makeRegistry([{}, {}]);
    expect(registry.snapshots()).toHaveLength(2);
    expect(registry.get('nope')).toBeUndefined();
  });
});
