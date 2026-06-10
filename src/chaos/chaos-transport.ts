import { sleep } from '../internal/async.js';
import type { RpcTransport } from '../transport/types.js';
import { gaussian, mulberry32, pareto } from './prng.js';

/**
 * Declarative fault plan for {@link createChaosTransport}.
 *
 * All rates are probabilities in [0, 1], evaluated per request in this order:
 * flapping window → dropRate → httpErrors → rpcErrors → slowLoris → latency.
 */
export interface FaultPlan {
  /** PRNG seed; identical seeds reproduce identical fault sequences. */
  readonly seed?: number;
  /** Added latency before the request reaches the inner transport. */
  readonly latency?: {
    readonly meanMs: number;
    readonly jitterMs?: number;
    readonly distribution?: 'fixed' | 'normal' | 'pareto';
  };
  /** Probability that the request fails like a severed connection. */
  readonly dropRate?: number;
  /** Injected HTTP-level failures (shaped like kit's transport errors). */
  readonly httpErrors?: ReadonlyArray<{
    readonly status: number;
    readonly rate: number;
    readonly retryAfterMs?: number;
  }>;
  /** Injected JSON-RPC error envelopes (returned, not thrown — like a real node). */
  readonly rpcErrors?: ReadonlyArray<{
    readonly code: number;
    readonly message: string;
    readonly rate: number;
    readonly methods?: readonly string[];
  }>;
  /** Probability that a request hangs for `hangMs` before completing. */
  readonly slowLoris?: { readonly rate: number; readonly hangMs: number };
  /** Total outage windows: up for `upMs`, then down (drops everything) for `downMs`, repeating. */
  readonly flapping?: { readonly upMs: number; readonly downMs: number };
  /** Phased plans: after `afterMs` from creation, merge `plan` over the base plan. */
  readonly schedule?: ReadonlyArray<{ readonly afterMs: number; readonly plan: Partial<FaultPlan> }>;
}

export interface ChaosStats {
  calls: number;
  passedThrough: number;
  dropped: number;
  injectedHttpErrors: number;
  injectedRpcErrors: number;
  slowLorisHangs: number;
  flappingDrops: number;
}

export interface ChaosTransport extends RpcTransport {
  readonly stats: Readonly<ChaosStats>;
  setPlan(plan: FaultPlan): void;
}

interface ChaosOptions {
  readonly now?: () => number;
}

function getMethod(payload: unknown): string {
  return typeof payload === 'object' && payload !== null && 'method' in payload
    ? String((payload as { method: unknown }).method)
    : 'unknown';
}

/** Error shaped like a dropped TCP connection (matches undici/fetch behavior). */
function connectionDropError(): Error {
  return Object.assign(new TypeError('fetch failed (chaos: connection dropped)'), {
    code: 'ECONNRESET',
  });
}

/** Error shaped like kit's SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR. */
function httpError(status: number, retryAfterMs?: number): Error {
  const headers: Record<string, string> = {};
  if (retryAfterMs !== undefined) headers['retry-after'] = String(Math.ceil(retryAfterMs / 1000));
  return Object.assign(new Error(`HTTP error (${status}) (chaos)`), {
    context: { statusCode: status, headers },
  });
}

/**
 * Wrap any transport with deterministic, scriptable fault injection.
 *
 * Shipped as part of the SDK (`solana-shield/chaos`) so dApps can test their own
 * behavior against a hostile network — the same rig solana-shield's own test
 * suite runs on.
 */
export function createChaosTransport(
  inner: RpcTransport,
  initialPlan: FaultPlan = {},
  options: ChaosOptions = {},
): ChaosTransport {
  const now = options.now ?? Date.now;
  const createdAt = now();
  let basePlan = initialPlan;
  let random = mulberry32(initialPlan.seed ?? 42);

  const stats: ChaosStats = {
    calls: 0,
    passedThrough: 0,
    dropped: 0,
    injectedHttpErrors: 0,
    injectedRpcErrors: 0,
    slowLorisHangs: 0,
    flappingDrops: 0,
  };

  function effectivePlan(): FaultPlan {
    if (!basePlan.schedule || basePlan.schedule.length === 0) return basePlan;
    const elapsed = now() - createdAt;
    let plan: FaultPlan = basePlan;
    for (const phase of basePlan.schedule) {
      if (elapsed >= phase.afterMs) plan = { ...plan, ...phase.plan };
    }
    return plan;
  }

  function latencyMs(plan: FaultPlan): number {
    if (!plan.latency) return 0;
    const { meanMs, jitterMs = 0, distribution = 'fixed' } = plan.latency;
    switch (distribution) {
      case 'fixed':
        return Math.max(0, meanMs + (random() * 2 - 1) * jitterMs);
      case 'normal':
        return Math.max(0, meanMs + gaussian(random) * (jitterMs || meanMs / 4));
      case 'pareto':
        // pareto(2) has mean 2 at minimum 1 → scale so the sample mean ≈ meanMs.
        return Math.max(0, (pareto(random) * meanMs) / 2);
    }
  }

  const transport = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    stats.calls += 1;
    const plan = effectivePlan();
    const method = getMethod(config.payload);

    if (plan.flapping) {
      const { upMs, downMs } = plan.flapping;
      const phase = (now() - createdAt) % (upMs + downMs);
      if (phase >= upMs) {
        stats.flappingDrops += 1;
        throw connectionDropError();
      }
    }

    if (plan.dropRate !== undefined && random() < plan.dropRate) {
      stats.dropped += 1;
      throw connectionDropError();
    }

    for (const spec of plan.httpErrors ?? []) {
      if (random() < spec.rate) {
        stats.injectedHttpErrors += 1;
        throw httpError(spec.status, spec.retryAfterMs);
      }
    }

    for (const spec of plan.rpcErrors ?? []) {
      if (spec.methods && !spec.methods.includes(method)) continue;
      if (random() < spec.rate) {
        stats.injectedRpcErrors += 1;
        const id =
          typeof config.payload === 'object' && config.payload !== null && 'id' in config.payload
            ? (config.payload as { id: unknown }).id
            : null;
        return { error: { code: spec.code, message: spec.message }, id, jsonrpc: '2.0' };
      }
    }

    if (plan.slowLoris && random() < plan.slowLoris.rate) {
      stats.slowLorisHangs += 1;
      await sleep(plan.slowLoris.hangMs, config.signal);
    }

    const delay = latencyMs(plan);
    if (delay > 0) await sleep(delay, config.signal);

    stats.passedThrough += 1;
    return inner(config);
  }) as ChaosTransport;

  Object.defineProperty(transport, 'stats', { get: () => ({ ...stats }) });
  (transport as { setPlan?: (plan: FaultPlan) => void }).setPlan = (plan: FaultPlan) => {
    basePlan = plan;
    if (plan.seed !== undefined) random = mulberry32(plan.seed);
  };

  return transport;
}
