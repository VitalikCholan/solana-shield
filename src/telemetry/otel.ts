import type { MetricsRegistry } from './registry.js';

/**
 * Optional OpenTelemetry mirror.
 *
 * `@opentelemetry/api` is an optional peer dependency loaded dynamically: when
 * it isn't installed this module no-ops. The SDK never instantiates an OTel
 * SDK or exporter — the host application wires `@opentelemetry/sdk-node` (or
 * the browser equivalent) with an OTLP exporter pointed at its collector /
 * Datadog Agent, and every solana-shield metric flows through automatically.
 */

export interface OtelMirrorOptions {
  /** Meter name (default 'solana-shield'). */
  readonly meterName?: string;
}

export interface OtelMirror {
  readonly enabled: boolean;
  /** Stop mirroring metrics. */
  disable(): void;
}

interface MinimalCounter {
  add(value: number, attributes?: Record<string, string>): void;
}
interface MinimalHistogram {
  record(value: number, attributes?: Record<string, string>): void;
}
interface MinimalGauge {
  record(value: number, attributes?: Record<string, string>): void;
}
interface MinimalMeter {
  createCounter(name: string): MinimalCounter;
  createHistogram(name: string): MinimalHistogram;
  createGauge?(name: string): MinimalGauge;
  createUpDownCounter(name: string): MinimalCounter;
}

/**
 * Mirror every metric recorded by the registry into OpenTelemetry instruments.
 * Resolves to a disabled mirror (with a console hint) when `@opentelemetry/api`
 * is not installed.
 */
export async function enableOpenTelemetry(
  metrics: MetricsRegistry,
  options: OtelMirrorOptions = {},
): Promise<OtelMirror> {
  let meter: MinimalMeter;
  try {
    const api = (await import('@opentelemetry/api')) as unknown as {
      metrics: { getMeter(name: string): MinimalMeter };
    };
    meter = api.metrics.getMeter(options.meterName ?? 'solana-shield');
  } catch {
    return {
      enabled: false,
      disable() {},
    };
  }

  const counters = new Map<string, MinimalCounter>();
  const histograms = new Map<string, MinimalHistogram>();
  const gauges = new Map<string, MinimalGauge | MinimalCounter>();
  // Gauges need delta emulation when the api lacks sync gauges (pre-1.9).
  const gaugeValues = new Map<string, number>();

  const unsubscribe = metrics.onRecord(record => {
    const name = record.name;
    const labels = record.labels as Record<string, string>;
    switch (record.type) {
      case 'counter': {
        let counter = counters.get(name);
        if (!counter) {
          counter = meter.createCounter(name);
          counters.set(name, counter);
        }
        counter.add(record.value, labels);
        break;
      }
      case 'histogram': {
        let histogram = histograms.get(name);
        if (!histogram) {
          histogram = meter.createHistogram(name);
          histograms.set(name, histogram);
        }
        histogram.record(record.value, labels);
        break;
      }
      case 'gauge': {
        const key = `${name}:${JSON.stringify(labels)}`;
        let gauge = gauges.get(name);
        if (!gauge) {
          gauge = meter.createGauge
            ? meter.createGauge(name)
            : meter.createUpDownCounter(name);
          gauges.set(name, gauge);
        }
        if ('record' in gauge) {
          gauge.record(record.value, labels);
        } else {
          const previous = gaugeValues.get(key) ?? 0;
          gauge.add(record.value - previous, labels);
        }
        gaugeValues.set(key, record.value);
        break;
      }
    }
  });

  return {
    enabled: true,
    disable: unsubscribe,
  };
}
