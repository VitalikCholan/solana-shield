import { sleep } from '../internal/async.js';
import { MetricsRegistry } from '../telemetry/registry.js';
import { EndpointSelector } from './balancer.js';
import type { BreakerOptions } from './circuit-breaker.js';
import { classifyFailure, classifyRpcErrorResponse } from './classify.js';
import type { EndpointInit, ScoreFunction } from './health.js';
import { HealthRegistry } from './health.js';
import type { RetryPolicy } from './retry.js';
import { DEFAULT_RETRY_POLICY, computeBackoffMs } from './retry.js';
import type { ClassifiedFailure, RpcTransport } from './types.js';
import { AllEndpointsFailedError, isJsonRpcPayload } from './types.js';

/** A function that wraps a transport with additional behavior (telemetry, hedging, ...). */
export type TransportMiddleware = (next: RpcTransport) => RpcTransport;

/** Apply middlewares around a base transport; the first middleware is outermost. */
export function composeTransport(
  base: RpcTransport,
  ...middlewares: TransportMiddleware[]
): RpcTransport {
  return middlewares.reduceRight((next, middleware) => middleware(next), base);
}

export interface ResilientTransportOptions {
  readonly endpoints: readonly EndpointInit[];
  readonly metrics?: MetricsRegistry;
  readonly retry?: Partial<RetryPolicy>;
  /** Per-attempt timeout (default 10s). */
  readonly requestTimeoutMs?: number;
  readonly scoreFn?: ScoreFunction;
  readonly breaker?: BreakerOptions;
  readonly now?: () => number;
  readonly random?: () => number;
}

export interface ResilientTransport {
  readonly transport: RpcTransport;
  readonly health: HealthRegistry;
  readonly metrics: MetricsRegistry;
  readonly selector: EndpointSelector;
}

/**
 * The resilience core: a kit-compatible `RpcTransport` that, per logical request,
 * runs an attempt loop of `select endpoint → call with timeout → classify outcome`,
 * rotating away from failing endpoints with full-jitter backoff between attempts.
 *
 * Failure policy lives in {@link classifyFailure}; endpoint accounting (EWMAs,
 * breaker, cooldowns) lives in {@link HealthRegistry}.
 */
export function createResilientTransport(options: ResilientTransportOptions): ResilientTransport {
  const metrics = options.metrics ?? new MetricsRegistry();
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const policy: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;

  const health = new HealthRegistry(options.endpoints, {
    metrics,
    ...(options.scoreFn ? { scoreFn: options.scoreFn } : {}),
    ...(options.breaker ? { breaker: options.breaker } : {}),
    now,
  });
  const selector = new EndpointSelector(health, random);

  const transport = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    const { payload, signal: callerSignal } = config;
    const method = isJsonRpcPayload(payload) ? payload.method : 'unknown';
    const failures: ClassifiedFailure[] = [];
    const tried = new Set<string>();
    const startedAt = now();
    let lastRpcErrorResponse: unknown;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      callerSignal?.throwIfAborted();

      const endpoint = selector.select(tried);
      if (!endpoint) break;
      tried.add(endpoint.id);

      // Proactive rate cap: wait for a token rather than provoking a 429.
      if (endpoint.bucket && !endpoint.bucket.tryRemove()) {
        await sleep(endpoint.bucket.msUntilAvailable(), callerSignal);
        endpoint.bucket.tryRemove();
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, requestTimeoutMs);
      const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

      const attemptStart = now();
      try {
        const response = await endpoint.transport({ payload, signal: controller.signal });
        const latency = now() - attemptStart;
        const rpcFailure = classifyRpcErrorResponse(response);
        if (rpcFailure) {
          endpoint.recordFailure(rpcFailure, latency, method);
          failures.push(rpcFailure);
          lastRpcErrorResponse = response;
        } else {
          endpoint.recordSuccess(latency, method);
          finishLogicalRequest('success');
          return response;
        }
      } catch (err) {
        const latency = now() - attemptStart;
        if (callerSignal?.aborted) {
          // Caller cancelled: surface as-is, never blame the endpoint.
          finishLogicalRequest('aborted');
          throw err;
        }
        const failure = classifyFailure(err, { timedOut });
        endpoint.recordFailure(failure, latency, method);
        failures.push(failure);
        if (!failure.retryable && !canRetryElsewhere(failure)) {
          finishLogicalRequest('failure');
          throw err;
        }
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener('abort', onCallerAbort);
      }

      if (attempt < policy.maxAttempts - 1) {
        await sleep(computeBackoffMs(policy, attempt, random), callerSignal);
      }
    }

    if (lastRpcErrorResponse !== undefined) {
      // Every healthy-node retry was exhausted but we do hold a JSON-RPC error
      // response: hand it to kit so the caller sees the real RPC error.
      finishLogicalRequest('rpc-error');
      return lastRpcErrorResponse;
    }
    finishLogicalRequest('failure');
    throw new AllEndpointsFailedError(failures);

    function canRetryElsewhere(failure: ClassifiedFailure): boolean {
      if (!failure.markDead) return false;
      return health.all().some(e => !e.dead && !tried.has(e.id));
    }

    function finishLogicalRequest(outcome: string): void {
      metrics.histogram('solana_shield.rpc.logical_request.duration', now() - startedAt, {
        method,
        outcome,
      });
      metrics.count('solana_shield.rpc.logical_request.count', { method, outcome });
    }
  }) as RpcTransport;

  return { transport, health, metrics, selector };
}
