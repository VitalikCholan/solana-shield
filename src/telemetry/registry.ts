/**
 * Zero-dependency in-process metrics. Always on: powers endpoint health scoring,
 * the hedging p95 signal, the CLI `monitor` table, and (optionally, via
 * `solana-shield/telemetry`'s OTel mirror) external observability backends.
 */

export type Labels = Readonly<Record<string, string>>;

export interface MetricRecord {
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly name: string;
  readonly labels: Labels;
  readonly value: number;
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
}

/** Fixed-capacity ring buffer of recent observations with quantile queries. */
export class RollingHistogram {
  private readonly values: number[];
  private next = 0;
  private filled = false;
  private total = 0;
  private sum = 0;

  constructor(private readonly capacity = 512) {
    this.values = new Array<number>(capacity);
  }

  record(value: number): void {
    this.values[this.next] = value;
    this.next = (this.next + 1) % this.capacity;
    if (this.next === 0) this.filled = true;
    this.total += 1;
    this.sum += value;
  }

  get count(): number {
    return this.total;
  }

  quantile(q: number): number {
    const size = this.filled ? this.capacity : this.next;
    if (size === 0) return 0;
    const sorted = this.values.slice(0, size).sort((a, b) => a - b);
    const index = Math.min(size - 1, Math.max(0, Math.ceil(q * size) - 1));
    return sorted[index] ?? 0;
  }

  snapshot(): HistogramSnapshot {
    const size = this.filled ? this.capacity : this.next;
    const sorted = this.values.slice(0, size).sort((a, b) => a - b);
    const at = (q: number) =>
      size === 0 ? 0 : (sorted[Math.min(size - 1, Math.max(0, Math.ceil(q * size) - 1))] ?? 0);
    const windowSum = sorted.reduce((a, b) => a + b, 0);
    return {
      count: this.total,
      mean: size === 0 ? 0 : windowSum / size,
      max: size === 0 ? 0 : (sorted[size - 1] ?? 0),
      p50: at(0.5),
      p90: at(0.9),
      p95: at(0.95),
      p99: at(0.99),
    };
  }
}

function encodeKey(name: string, labels: Labels | undefined): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`);
  return parts.length === 0 ? name : `${name}{${parts.join(',')}}`;
}

function decodeKey(key: string): { name: string; labels: Labels } {
  const brace = key.indexOf('{');
  if (brace === -1) return { name: key, labels: {} };
  const name = key.slice(0, brace);
  const labels: Record<string, string> = {};
  for (const pair of key.slice(brace + 1, -1).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) labels[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return { name, labels };
}

export interface MetricsSnapshotEntry {
  readonly type: 'counter' | 'gauge' | 'histogram';
  readonly name: string;
  readonly labels: Labels;
  readonly value: number | HistogramSnapshot;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, RollingHistogram>();
  private readonly listeners = new Set<(record: MetricRecord) => void>();

  count(name: string, labels?: Labels, delta = 1): void {
    const key = encodeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
    this.emit({ type: 'counter', name, labels: labels ?? {}, value: delta });
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(encodeKey(name, labels), value);
    this.emit({ type: 'gauge', name, labels: labels ?? {}, value });
  }

  histogram(name: string, value: number, labels?: Labels): void {
    const key = encodeKey(name, labels);
    let hist = this.histograms.get(key);
    if (!hist) {
      hist = new RollingHistogram();
      this.histograms.set(key, hist);
    }
    hist.record(value);
    this.emit({ type: 'histogram', name, labels: labels ?? {}, value });
  }

  getCounter(name: string, labels?: Labels): number {
    return this.counters.get(encodeKey(name, labels)) ?? 0;
  }

  getGauge(name: string, labels?: Labels): number | undefined {
    return this.gauges.get(encodeKey(name, labels));
  }

  getHistogram(name: string, labels?: Labels): RollingHistogram | undefined {
    return this.histograms.get(encodeKey(name, labels));
  }

  /**
   * Subscribe to every metric record as it happens (used by the OTel mirror).
   * Returns an unsubscribe function.
   */
  onRecord(listener: (record: MetricRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): MetricsSnapshotEntry[] {
    const entries: MetricsSnapshotEntry[] = [];
    for (const [key, value] of this.counters) {
      entries.push({ type: 'counter', ...decodeKey(key), value });
    }
    for (const [key, value] of this.gauges) {
      entries.push({ type: 'gauge', ...decodeKey(key), value });
    }
    for (const [key, hist] of this.histograms) {
      entries.push({ type: 'histogram', ...decodeKey(key), value: hist.snapshot() });
    }
    return entries;
  }

  private emit(record: MetricRecord): void {
    for (const listener of this.listeners) listener(record);
  }
}
