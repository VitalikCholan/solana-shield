import { describe, expect, it } from 'vitest';
import {
  collectMethodStats,
  renderHealthTable,
  renderMethodTable,
  renderTable,
  toJson,
} from '../../../src/cli/render.js';
import { MetricsRegistry } from '../../../src/telemetry/registry.js';
import type { EndpointHealthSnapshot } from '../../../src/transport/health.js';

 
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

function snapshot(overrides: Partial<EndpointHealthSnapshot> = {}): EndpointHealthSnapshot {
  return {
    id: 'a',
    url: 'https://a',
    label: 'helius-main',
    score: 0.95,
    breakerState: 'closed',
    dead: false,
    deadReason: undefined,
    coolingDownForMs: 0,
    latencyEwmaMs: 120,
    errorRateEwma: 0.02,
    slotLag: 1,
    p50Ms: 100,
    p95Ms: 250,
    totalRequests: 42,
    totalFailures: 1,
    lastFailure: 'HTTP 429 (rate limited)',
    ...overrides,
  };
}

describe('renderTable', () => {
  it('aligns columns and truncates long cells consistently', () => {
    const out = stripAnsi(renderTable(['A', 'LONGHEADER'], [['x', 'y'], ['longer', 'z']]));
    const lines = out.split('\n');
    expect(lines[0]).toBe('A       LONGHEADER');
    expect(lines[1]).toBe('x       y         ');
    expect(lines[2]).toBe('longer  z         ');
  });
});

describe('renderHealthTable', () => {
  it('renders one row per endpoint with badges', () => {
    const out = stripAnsi(
      renderHealthTable([
        snapshot(),
        snapshot({ id: 'b', label: 'backup', dead: true, breakerState: 'open', score: 0.1 }),
      ]),
    );
    expect(out).toContain('helius-main');
    expect(out).toContain('ok');
    expect(out).toContain('backup');
    expect(out).toContain('DEAD');
    expect(out).toContain('100ms');
    expect(out).toContain('HTTP 429');
  });

  it('renders cooldowns in seconds', () => {
    const out = stripAnsi(renderHealthTable([snapshot({ coolingDownForMs: 4200 })]));
    expect(out).toContain('5s');
  });
});

describe('collectMethodStats', () => {
  it('builds per-endpoint-method rows from the metrics snapshot', () => {
    const metrics = new MetricsRegistry();
    metrics.histogram('solana_shield.rpc.request.duration', 100, { endpoint: 'a', method: 'getSlot' });
    metrics.histogram('solana_shield.rpc.request.duration', 200, { endpoint: 'a', method: 'getSlot' });
    metrics.count('solana_shield.rpc.request.count', { endpoint: 'a', method: 'getSlot', outcome: 'success' }, 3);
    metrics.count('solana_shield.rpc.request.count', {
      endpoint: 'a',
      method: 'getSlot',
      outcome: 'failure',
      failure_kind: 'network',
    });
    const stats = collectMethodStats(metrics.snapshot());
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      endpoint: 'a',
      method: 'getSlot',
      count: 4,
      successRate: 0.75,
    });
    expect(stats[0]!.p50).toBeGreaterThan(0);
    const table = stripAnsi(renderMethodTable(stats));
    expect(table).toContain('getSlot');
    expect(table).toContain('75.0%');
  });

  it('ignores metrics without endpoint/method labels', () => {
    const metrics = new MetricsRegistry();
    metrics.count('solana_shield.tx.outcome', { outcome: 'confirmed' });
    expect(collectMethodStats(metrics.snapshot())).toHaveLength(0);
  });
});

describe('toJson', () => {
  it('serializes bigints as strings', () => {
    expect(toJson({ slot: 42n })).toContain('"slot": "42"');
  });
});
