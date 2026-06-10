import { describe, expect, it } from 'vitest';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { MetricsRegistry } from '../../../src/telemetry/registry.js';
import { enableOpenTelemetry } from '../../../src/telemetry/otel.js';

describe('enableOpenTelemetry', () => {
  it('mirrors counters, histograms, and gauges into the global meter provider', async () => {
    const recorded: Array<{ kind: string; name: string; value: number; attrs?: unknown }> = [];
    const fakeMeter = {
      createCounter: (name: string) => ({
        add: (value: number, attrs?: unknown) => recorded.push({ kind: 'counter', name, value, attrs }),
      }),
      createHistogram: (name: string) => ({
        record: (value: number, attrs?: unknown) =>
          recorded.push({ kind: 'histogram', name, value, attrs }),
      }),
      createGauge: (name: string) => ({
        record: (value: number, attrs?: unknown) => recorded.push({ kind: 'gauge', name, value, attrs }),
      }),
      createUpDownCounter: (name: string) => ({
        add: (value: number, attrs?: unknown) =>
          recorded.push({ kind: 'updown', name, value, attrs }),
      }),
    };
    const provider = {
      getMeter: () => fakeMeter,
    };
    otelMetrics.setGlobalMeterProvider(provider as never);
    try {
      const registry = new MetricsRegistry();
      const mirror = await enableOpenTelemetry(registry);
      expect(mirror.enabled).toBe(true);

      registry.count('solana_shield.rpc.request.count', { endpoint: 'a' });
      registry.histogram('solana_shield.rpc.request.duration', 42, { endpoint: 'a' });
      registry.gauge('solana_shield.endpoint.health_score', 0.9, { endpoint: 'a' });
      registry.count('solana_shield.rpc.request.count', { endpoint: 'a' }, 2);

      expect(recorded).toEqual([
        { kind: 'counter', name: 'solana_shield.rpc.request.count', value: 1, attrs: { endpoint: 'a' } },
        { kind: 'histogram', name: 'solana_shield.rpc.request.duration', value: 42, attrs: { endpoint: 'a' } },
        { kind: 'gauge', name: 'solana_shield.endpoint.health_score', value: 0.9, attrs: { endpoint: 'a' } },
        { kind: 'counter', name: 'solana_shield.rpc.request.count', value: 2, attrs: { endpoint: 'a' } },
      ]);

      mirror.disable();
      registry.count('after.disable');
      expect(recorded).toHaveLength(4);
    } finally {
      otelMetrics.disable();
    }
  });

  it('falls back to up-down counters for gauges on older API surfaces', async () => {
    const recorded: Array<{ name: string; value: number }> = [];
    const fakeMeter = {
      createCounter: () => ({ add: () => {} }),
      createHistogram: () => ({ record: () => {} }),
      createGauge: undefined,
      createUpDownCounter: (name: string) => ({
        add: (value: number) => recorded.push({ name, value }),
      }),
    };
    otelMetrics.setGlobalMeterProvider({ getMeter: () => fakeMeter } as never);
    try {
      const registry = new MetricsRegistry();
      const mirror = await enableOpenTelemetry(registry);
      registry.gauge('score', 5);
      registry.gauge('score', 3);
      // Delta emulation: +5 then -2.
      expect(recorded).toEqual([
        { name: 'score', value: 5 },
        { name: 'score', value: -2 },
      ]);
      mirror.disable();
    } finally {
      otelMetrics.disable();
    }
  });
});
