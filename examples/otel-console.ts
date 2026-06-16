/**
 * OpenTelemetry export demo.
 *
 * solana-shield ships @opentelemetry/api only; the host app owns the exporter.
 * Here we wire a CONSOLE exporter so you can see the metrics with no collector.
 * Swap in the OTLP exporter (commented below) to ship to Datadog / Grafana.
 *
 * Run (install the OTel SDK first — it's not a dependency of the SDK):
 *   pnpm add -D @opentelemetry/sdk-metrics
 *   npx tsx examples/otel-console.ts
 *
 * For Datadog: run the Datadog Agent with OTLP intake enabled (defaults to
 * localhost:4318), then:
 *   pnpm add -D @opentelemetry/sdk-metrics @opentelemetry/exporter-metrics-otlp-http
 *   (use the OTLP exporter block below instead of ConsoleMetricExporter)
 */
import { metrics } from '@opentelemetry/api';
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { createShield, enableOpenTelemetry } from '../src/index.js';

// --- 1. Stand up an OTel MeterProvider with an exporter (host app's job) ---
const reader = new PeriodicExportingMetricReader({
  exporter: new ConsoleMetricExporter(), // prints metrics to stdout every interval
  // For Datadog / any OTLP backend, replace the line above with:
  //   exporter: new OTLPMetricExporter({ url: 'http://localhost:4318/v1/metrics' }),
  exportIntervalMillis: 3000,
});
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

// --- 2. Tell solana-shield to mirror its metrics into OpenTelemetry ---
const shield = createShield({ endpoints: ['devnet'] });
const mirror = await enableOpenTelemetry(shield.metrics);
console.log(`OpenTelemetry mirror ${mirror.enabled ? 'enabled' : 'disabled (api missing)'}`);

// --- 3. Generate some RPC traffic so there are metrics to export ---
console.log('Firing 12 getSlot calls against devnet...');
for (let i = 0; i < 12; i++) {
  await shield.rpc.getSlot().send().catch(() => {});
  await new Promise(r => setTimeout(r, 250));
}

// --- 4. Let one export interval flush (watch for solana_shield.* metrics) ---
console.log('Waiting for the periodic exporter to flush...');
await new Promise(r => setTimeout(r, 3500));

await provider.shutdown();
shield.destroy();
console.log('Done. You should see solana_shield.rpc.request.duration / .count above.');
