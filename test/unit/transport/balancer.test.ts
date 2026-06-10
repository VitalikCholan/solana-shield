import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../src/chaos/prng.js';
import { MetricsRegistry } from '../../../src/telemetry/registry.js';
import { EndpointSelector } from '../../../src/transport/balancer.js';
import { HealthRegistry } from '../../../src/transport/health.js';
import type { ClassifiedFailure } from '../../../src/transport/types.js';
import { alwaysOk } from '../../helpers/mock-transport.js';

function setup(count: number, weights?: number[]) {
  const metrics = new MetricsRegistry();
  const time = { value: 0 };
  const registry = new HealthRegistry(
    Array.from({ length: count }, (_, i) => ({
      id: `ep-${i}`,
      url: `https://rpc-${i}.example.com`,
      transport: alwaysOk(),
      ...(weights?.[i] !== undefined ? { weight: weights[i] } : {}),
    })),
    { metrics, now: () => time.value },
  );
  const selector = new EndpointSelector(registry, mulberry32(7));
  return { registry, selector, time };
}

const rotateFailure: ClassifiedFailure = {
  kind: 'network',
  retryable: true,
  rotateEndpoint: true,
  markDead: false,
  message: 'fetch failed',
  cause: undefined,
};

describe('EndpointSelector', () => {
  it('returns the only endpoint when there is just one', () => {
    const { selector } = setup(1);
    expect(selector.select()?.id).toBe('ep-0');
  });

  it('steers the bulk of traffic away from a degraded endpoint', () => {
    const { registry, selector } = setup(3);
    // ep-2 is failing hard (but stays below breaker threshold each round).
    const bad = registry.get('ep-2')!;
    for (let i = 0; i < 4; i++) bad.recordFailure(rotateFailure, 2000, 'getSlot');
    registry.get('ep-0')!.recordSuccess(50, 'getSlot');
    registry.get('ep-1')!.recordSuccess(60, 'getSlot');

    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const id = selector.select()!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const badShare = (counts.get('ep-2') ?? 0) / 1000;
    expect(badShare).toBeLessThan(0.1);
    // The two healthy endpoints share the rest meaningfully (P2C, not best-only).
    expect(counts.get('ep-0')!).toBeGreaterThan(100);
    expect(counts.get('ep-1')!).toBeGreaterThan(100);
  });

  it('respects static weights', () => {
    const { selector } = setup(2, [10, 1]);
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const id = selector.select()!.id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.get('ep-0')!).toBeGreaterThan(counts.get('ep-1')!);
  });

  it('avoids endpoints already tried for this request when possible', () => {
    const { selector } = setup(2);
    for (let i = 0; i < 50; i++) {
      expect(selector.select(new Set(['ep-0']))!.id).toBe('ep-1');
    }
  });

  it('reuses tried endpoints when everything else is unavailable', () => {
    const { registry, selector } = setup(2);
    registry.get('ep-1')!.recordFailure({ ...rotateFailure, markDead: true }, 5, 'getSlot');
    expect(selector.select(new Set(['ep-0']))!.id).toBe('ep-0');
  });

  it('force-half-opens the best open endpoint instead of deadlocking in a total outage', () => {
    const { registry, selector, time } = setup(2);
    for (const ep of registry.all()) {
      for (let i = 0; i < 5; i++) ep.recordFailure(rotateFailure, 5, 'getSlot');
      expect(ep.breaker.state()).toBe('open');
    }
    // Give ep-1 a better score so the fallback should prefer it.
    time.value += 1; // (scores recompute lazily; just pick deterministically below)
    registry.get('ep-1')!.errorRateEwma = 0.1;
    const chosen = selector.select();
    expect(chosen).toBeDefined();
    expect(chosen!.id).toBe('ep-1');
    expect(chosen!.breaker.state()).toBe('half-open');
  });

  it('falls back to dead endpoints only when nothing alive remains', () => {
    const { registry, selector } = setup(2);
    for (const ep of registry.all()) {
      ep.recordFailure({ ...rotateFailure, markDead: true, message: 'HTTP 403' }, 5, 'getSlot');
    }
    const chosen = selector.select();
    expect(chosen).toBeDefined();
    expect(chosen!.dead).toBe(true);
  });
});
