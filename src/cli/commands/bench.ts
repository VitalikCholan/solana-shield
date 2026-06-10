import pc from 'picocolors';
import type { Shield } from '../../index.js';
import { RollingHistogram } from '../../telemetry/registry.js';
import { renderTable, toJson } from '../render.js';

export interface BenchEndpointResult {
  readonly label: string;
  readonly requests: number;
  readonly failures: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly throughputRps: number;
}

export interface BenchOptions {
  /** Total requests per endpoint (default 50). */
  readonly requests?: number;
  /** Concurrent in-flight requests per endpoint (default 5). */
  readonly concurrency?: number;
  readonly method?: string;
  readonly signal?: AbortSignal;
}

/**
 * Latency/throughput benchmark, run against each endpoint's raw transport
 * (bypassing retries — a bench should measure the node, not the resilience).
 */
export async function runBench(shield: Shield, options: BenchOptions = {}): Promise<BenchEndpointResult[]> {
  const requests = options.requests ?? 50;
  const concurrency = Math.max(1, options.concurrency ?? 5);
  const method = options.method ?? 'getSlot';

  return Promise.all(
    shield.health.all().map(async endpoint => {
      const hist = new RollingHistogram(Math.max(512, requests));
      let failures = 0;
      let next = 0;
      const startedAt = Date.now();
      async function worker(): Promise<void> {
        while (next < requests) {
          const id = `bench-${next++}`;
          options.signal?.throwIfAborted();
          const t0 = Date.now();
          try {
            await endpoint.transport({
              payload: { id, jsonrpc: '2.0', method, params: [] },
              ...(options.signal ? { signal: options.signal } : {}),
            });
            hist.record(Date.now() - t0);
          } catch {
            failures += 1;
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      const elapsed = Math.max(1, Date.now() - startedAt);
      const snapshot = hist.snapshot();
      return {
        label: endpoint.label,
        requests,
        failures,
        p50Ms: snapshot.p50,
        p95Ms: snapshot.p95,
        p99Ms: snapshot.p99,
        maxMs: snapshot.max,
        throughputRps: ((requests - failures) / elapsed) * 1000,
      };
    }),
  );
}

export function renderBenchReport(results: readonly BenchEndpointResult[], json: boolean): string {
  if (json) return toJson(results);
  return [
    pc.bold(`Benchmark (${results[0]?.requests ?? 0} requests per endpoint)`),
    renderTable(
      ['ENDPOINT', 'P50', 'P95', 'P99', 'MAX', 'FAILURES', 'THROUGHPUT'],
      results.map(r => [
        r.label,
        `${Math.round(r.p50Ms)}ms`,
        `${Math.round(r.p95Ms)}ms`,
        `${Math.round(r.p99Ms)}ms`,
        `${Math.round(r.maxMs)}ms`,
        r.failures > 0 ? pc.red(String(r.failures)) : '0',
        `${r.throughputRps.toFixed(1)} req/s`,
      ]),
    ),
  ].join('\n');
}
