import type { MetricsRegistry } from '../telemetry/registry.js';
import type { FeeEstimateRequest, FeeSource, FeeSourceContext } from './types.js';

export interface FeeOracleOptions {
  /** Per-request time budget for all sources combined (default 400ms). */
  readonly budgetMs?: number;
  /** Estimate cache TTL (default 2s — fee markets move per-block). */
  readonly cacheTtlMs?: number;
  readonly metrics?: MetricsRegistry;
  readonly now?: () => number;
}

/**
 * Races every configured fee source inside a fixed time budget and aggregates
 * with max-of-responses: overpaying slightly beats not landing, and a single
 * lowballing source can't sink the estimate. Sources that error or miss the
 * budget are simply ignored; if none respond the oracle throws and the
 * pipeline falls back to its 1 µlamport default (with the hard ceiling
 * applied above us either way).
 *
 * The oracle is itself a {@link FeeSource}, so it plugs straight into the
 * transaction pipeline and composes (an oracle of oracles works fine).
 */
export class FeeOracle implements FeeSource {
  readonly name: string;
  private readonly budgetMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, { value: bigint; source: string; expiresAt: number }>();

  constructor(
    private readonly sources: readonly FeeSource[],
    private readonly options: FeeOracleOptions = {},
  ) {
    if (sources.length === 0) throw new Error('FeeOracle requires at least one fee source');
    this.name = `oracle(${sources.map(s => s.name).join('+')})`;
    this.budgetMs = options.budgetMs ?? 400;
    this.cacheTtlMs = options.cacheTtlMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  async estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint> {
    const cacheKey = `${request.level}:${[...request.writableAddresses].sort().join(',')}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) {
      return cached.value;
    }

    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(new Error('fee budget exhausted')), this.budgetMs);
    const onCallerAbort = (): void => budget.abort(context.signal?.reason);
    context.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      const settled = await Promise.allSettled(
        this.sources.map(async source => {
          const started = this.now();
          const value = await source.estimate(request, { signal: budget.signal });
          this.options.metrics?.histogram('solana_shield.fees.source.duration', this.now() - started, {
            source: source.name,
          });
          return { source: source.name, value };
        }),
      );
      const successes = settled.flatMap(result =>
        result.status === 'fulfilled' ? [result.value] : [],
      );
      for (const result of settled) {
        if (result.status === 'rejected') {
          this.options.metrics?.count('solana_shield.fees.source.error', {});
        }
      }
      if (successes.length === 0) {
        throw new Error(`All fee sources failed within ${this.budgetMs}ms budget`);
      }
      const best = successes.reduce((a, b) => (b.value > a.value ? b : a));
      const value = best.value < 1n ? 1n : best.value;
      this.cache.set(cacheKey, { value, source: best.source, expiresAt: this.now() + this.cacheTtlMs });
      this.options.metrics?.gauge('solana_shield.tx.fee.micro_lamports_per_cu', Number(value));
      return value;
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  /** Per-source estimates side by side (used by the `fees` CLI command). */
  async compare(
    request: FeeEstimateRequest,
    context: FeeSourceContext = {},
  ): Promise<Array<{ source: string; value?: bigint; error?: string }>> {
    return Promise.all(
      this.sources.map(async source => {
        try {
          return { source: source.name, value: await source.estimate(request, context) };
        } catch (err) {
          return { source: source.name, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
  }
}
