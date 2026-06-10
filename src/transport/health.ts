import type { MetricsRegistry } from '../telemetry/registry.js';
import { RollingHistogram } from '../telemetry/registry.js';
import type { BreakerOptions, BreakerState } from './circuit-breaker.js';
import { CircuitBreaker } from './circuit-breaker.js';
import { TokenBucket, defaultRateLimitCooldownMs } from './rate-limit.js';
import type { ClassifiedFailure, RpcTransport } from './types.js';

export interface EndpointInit {
  readonly id: string;
  readonly url: string;
  readonly wsUrl?: string;
  readonly label?: string;
  /** Static selection weight (default 1). Multiplied by the live health score. */
  readonly weight?: number;
  /** Proactive request-per-second cap (e.g. free provider tiers). */
  readonly rps?: number;
  readonly transport: RpcTransport;
}

export interface ScoreInputs {
  readonly latencyEwmaMs: number;
  readonly errorRateEwma: number;
  readonly slotLag: number;
}

export type ScoreFunction = (inputs: ScoreInputs) => number;

/**
 * Default health score. Success rate dominates super-linearly (cubed) — modeled
 * on Chainstack's public RPC benchmark methodology, where reliability is scored
 * far above raw speed — then latency and slot lag share the remainder.
 * Returns a value in (0, 1]; never 0 so weighted sampling stays well-defined.
 */
export const defaultScore: ScoreFunction = ({ latencyEwmaMs, errorRateEwma, slotLag }) => {
  const successFactor = (1 - Math.min(1, errorRateEwma)) ** 3;
  const latencyFactor = 1 - Math.min(1, latencyEwmaMs / 2000);
  const slotLagFactor = 1 - Math.min(1, slotLag / 50);
  return Math.max(0.001, successFactor * (0.7 * latencyFactor + 0.3 * slotLagFactor));
};

export interface EndpointHealthSnapshot {
  readonly id: string;
  readonly url: string;
  readonly label: string;
  readonly score: number;
  readonly breakerState: BreakerState;
  readonly dead: boolean;
  readonly deadReason: string | undefined;
  readonly coolingDownForMs: number;
  readonly latencyEwmaMs: number;
  readonly errorRateEwma: number;
  readonly slotLag: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly totalRequests: number;
  readonly totalFailures: number;
  readonly lastFailure: string | undefined;
}

const LATENCY_EWMA_ALPHA = 0.2;
const ERROR_EWMA_ALPHA = 0.1;

export class EndpointState {
  readonly id: string;
  readonly url: string;
  readonly wsUrl: string | undefined;
  readonly label: string;
  readonly weight: number;
  readonly transport: RpcTransport;
  readonly breaker: CircuitBreaker;
  readonly bucket: TokenBucket | undefined;

  latencyEwmaMs = 0;
  errorRateEwma = 0;
  slotLag = 0;
  dead = false;
  deadReason: string | undefined;
  totalRequests = 0;
  totalFailures = 0;
  lastFailure: string | undefined;

  private cooldownUntil = 0;
  private consecutiveRateLimits = 0;
  private readonly latencies = new RollingHistogram(256);
  private hasLatencySample = false;

  constructor(
    init: EndpointInit,
    private readonly scoreFn: ScoreFunction,
    private readonly metrics: MetricsRegistry,
    breakerOptions: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.id = init.id;
    this.url = init.url;
    this.wsUrl = init.wsUrl;
    this.label = init.label ?? init.id;
    this.weight = init.weight ?? 1;
    this.transport = init.transport;
    this.breaker = new CircuitBreaker({ now: this.now, ...breakerOptions });
    this.bucket = init.rps !== undefined ? new TokenBucket(init.rps, init.rps, this.now) : undefined;
  }

  score(): number {
    return this.scoreFn({
      latencyEwmaMs: this.latencyEwmaMs,
      errorRateEwma: this.errorRateEwma,
      slotLag: this.slotLag,
    });
  }

  /** Available = not dead, not cooling down, breaker not open, rate cap not exhausted. */
  isAvailable(): boolean {
    if (this.dead) return false;
    if (this.now() < this.cooldownUntil) return false;
    const state = this.breaker.state();
    if (state === 'open') return false;
    if (this.bucket && this.bucket.msUntilAvailable() > 0) return false;
    return true;
  }

  recordSuccess(latencyMs: number, method: string): void {
    this.totalRequests += 1;
    this.consecutiveRateLimits = 0;
    this.latencyEwmaMs = this.hasLatencySample
      ? this.latencyEwmaMs + LATENCY_EWMA_ALPHA * (latencyMs - this.latencyEwmaMs)
      : latencyMs;
    this.hasLatencySample = true;
    this.errorRateEwma *= 1 - ERROR_EWMA_ALPHA;
    this.latencies.record(latencyMs);
    this.breaker.recordSuccess();
    this.metrics.histogram('solana_shield.rpc.request.duration', latencyMs, {
      endpoint: this.label,
      method,
    });
    this.metrics.count('solana_shield.rpc.request.count', {
      endpoint: this.label,
      method,
      outcome: 'success',
    });
    this.publishScore();
  }

  recordFailure(failure: ClassifiedFailure, latencyMs: number, method: string): void {
    this.totalRequests += 1;
    this.totalFailures += 1;
    this.lastFailure = failure.message;
    this.errorRateEwma = this.errorRateEwma + ERROR_EWMA_ALPHA * (1 - this.errorRateEwma);
    if (failure.rotateEndpoint) this.breaker.recordFailure();
    if (failure.markDead) {
      this.dead = true;
      this.deadReason = failure.message;
    }
    if (failure.httpStatus === 429 || /rate limited/.test(failure.message)) {
      this.consecutiveRateLimits += 1;
      const cooldown =
        failure.cooldownMs ?? defaultRateLimitCooldownMs(this.consecutiveRateLimits);
      this.setCooldown(cooldown);
    } else if (failure.cooldownMs !== undefined) {
      this.setCooldown(failure.cooldownMs);
    }
    this.metrics.count('solana_shield.rpc.request.count', {
      endpoint: this.label,
      method,
      outcome: 'failure',
      failure_kind: failure.kind,
    });
    this.metrics.histogram('solana_shield.rpc.request.duration', latencyMs, {
      endpoint: this.label,
      method,
    });
    this.publishScore();
  }

  setCooldown(durationMs: number): void {
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + durationMs);
  }

  coolingDownForMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  setSlotLag(lag: number): void {
    this.slotLag = lag;
    this.metrics.gauge('solana_shield.endpoint.slot_lag', lag, { endpoint: this.label });
    this.publishScore();
  }

  /** Bring a dead endpoint back (e.g. user fixed the API key and `doctor` re-checked). */
  revive(): void {
    this.dead = false;
    this.deadReason = undefined;
  }

  snapshot(): EndpointHealthSnapshot {
    const latSnapshot = this.latencies.snapshot();
    return {
      id: this.id,
      url: this.url,
      label: this.label,
      score: this.score(),
      breakerState: this.breaker.state(),
      dead: this.dead,
      deadReason: this.deadReason,
      coolingDownForMs: this.coolingDownForMs(),
      latencyEwmaMs: this.latencyEwmaMs,
      errorRateEwma: this.errorRateEwma,
      slotLag: this.slotLag,
      p50Ms: latSnapshot.p50,
      p95Ms: latSnapshot.p95,
      totalRequests: this.totalRequests,
      totalFailures: this.totalFailures,
      lastFailure: this.lastFailure,
    };
  }

  private publishScore(): void {
    this.metrics.gauge('solana_shield.endpoint.health_score', this.score(), {
      endpoint: this.label,
    });
  }
}

export interface HealthRegistryOptions {
  readonly metrics: MetricsRegistry;
  readonly scoreFn?: ScoreFunction;
  readonly breaker?: BreakerOptions;
  readonly now?: () => number;
}

/** Single source of truth for endpoint health; feeds the balancer, telemetry, and the CLI. */
export class HealthRegistry {
  private readonly endpoints = new Map<string, EndpointState>();
  readonly metrics: MetricsRegistry;

  constructor(inits: readonly EndpointInit[], options: HealthRegistryOptions) {
    this.metrics = options.metrics;
    const scoreFn = options.scoreFn ?? defaultScore;
    for (const init of inits) {
      if (this.endpoints.has(init.id)) {
        throw new Error(`Duplicate endpoint id: ${init.id}`);
      }
      this.endpoints.set(
        init.id,
        new EndpointState(init, scoreFn, options.metrics, options.breaker ?? {}, options.now),
      );
    }
    if (this.endpoints.size === 0) {
      throw new Error('At least one RPC endpoint is required');
    }
  }

  get(id: string): EndpointState | undefined {
    return this.endpoints.get(id);
  }

  all(): EndpointState[] {
    return [...this.endpoints.values()];
  }

  available(): EndpointState[] {
    return this.all().filter(e => e.isAvailable());
  }

  snapshots(): EndpointHealthSnapshot[] {
    return this.all().map(e => e.snapshot());
  }

  /** Feed slot observations (from the background probe); recomputes lag for every endpoint. */
  recordSlots(slotById: ReadonlyMap<string, bigint>): void {
    let max = 0n;
    for (const slot of slotById.values()) if (slot > max) max = slot;
    for (const [id, slot] of slotById) {
      const endpoint = this.endpoints.get(id);
      if (endpoint) endpoint.setSlotLag(Number(max - slot));
    }
  }
}
