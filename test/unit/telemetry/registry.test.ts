import { describe, expect, it } from 'vitest';
import { MetricsRegistry, RollingHistogram } from '../../../src/telemetry/registry.js';

describe('RollingHistogram', () => {
  it('computes quantiles over recorded values', () => {
    const hist = new RollingHistogram(100);
    for (let i = 1; i <= 100; i++) hist.record(i);
    expect(hist.quantile(0.5)).toBe(50);
    expect(hist.quantile(0.95)).toBe(95);
    expect(hist.quantile(0)).toBe(1);
    expect(hist.quantile(1)).toBe(100);
  });

  it('evicts oldest values once capacity wraps', () => {
    const hist = new RollingHistogram(10);
    for (let i = 1; i <= 20; i++) hist.record(i);
    // Window holds 11..20.
    expect(hist.quantile(0)).toBe(11);
    expect(hist.count).toBe(20);
    expect(hist.snapshot().max).toBe(20);
  });

  it('returns zeros when empty', () => {
    const hist = new RollingHistogram();
    expect(hist.quantile(0.5)).toBe(0);
    expect(hist.snapshot()).toMatchObject({ count: 0, mean: 0, max: 0, p50: 0 });
  });

  it('snapshot reports window mean and percentiles', () => {
    const hist = new RollingHistogram(4);
    [10, 20, 30, 40].forEach(v => hist.record(v));
    const snap = hist.snapshot();
    expect(snap.mean).toBe(25);
    expect(snap.p50).toBe(20);
    expect(snap.p99).toBe(40);
  });
});

describe('MetricsRegistry', () => {
  it('accumulates counters per label set', () => {
    const m = new MetricsRegistry();
    m.count('req', { endpoint: 'a' });
    m.count('req', { endpoint: 'a' }, 2);
    m.count('req', { endpoint: 'b' });
    expect(m.getCounter('req', { endpoint: 'a' })).toBe(3);
    expect(m.getCounter('req', { endpoint: 'b' })).toBe(1);
    expect(m.getCounter('req', { endpoint: 'missing' })).toBe(0);
  });

  it('treats label order as irrelevant', () => {
    const m = new MetricsRegistry();
    m.count('req', { a: '1', b: '2' });
    expect(m.getCounter('req', { b: '2', a: '1' })).toBe(1);
  });

  it('stores gauges and histograms', () => {
    const m = new MetricsRegistry();
    m.gauge('score', 0.9, { endpoint: 'a' });
    expect(m.getGauge('score', { endpoint: 'a' })).toBe(0.9);
    expect(m.getGauge('score', { endpoint: 'zzz' })).toBeUndefined();
    m.histogram('lat', 100);
    m.histogram('lat', 200);
    expect(m.getHistogram('lat')?.snapshot().mean).toBe(150);
    expect(m.getHistogram('nope')).toBeUndefined();
  });

  it('notifies listeners on every record and supports unsubscribe', () => {
    const m = new MetricsRegistry();
    const seen: string[] = [];
    const unsubscribe = m.onRecord(r => seen.push(`${r.type}:${r.name}=${r.value}`));
    m.count('c');
    m.gauge('g', 5);
    m.histogram('h', 7);
    unsubscribe();
    m.count('c');
    expect(seen).toEqual(['counter:c=1', 'gauge:g=5', 'histogram:h=7']);
  });

  it('produces a structured snapshot with decoded labels', () => {
    const m = new MetricsRegistry();
    m.count('req', { endpoint: 'a', method: 'getSlot' });
    m.gauge('score', 1);
    m.histogram('lat', 10, { endpoint: 'a' });
    const snapshot = m.snapshot();
    const counter = snapshot.find(e => e.type === 'counter');
    expect(counter).toMatchObject({
      name: 'req',
      labels: { endpoint: 'a', method: 'getSlot' },
      value: 1,
    });
    const gauge = snapshot.find(e => e.type === 'gauge');
    expect(gauge).toMatchObject({ name: 'score', labels: {}, value: 1 });
    const hist = snapshot.find(e => e.type === 'histogram');
    expect(hist?.name).toBe('lat');
  });
});
