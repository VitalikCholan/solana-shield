/**
 * Structural clone of `RpcTransport` from `@solana/rpc-spec` (re-exported by `@solana/kit`).
 *
 * Defined locally so the transport layer (and the `solana-shield/chaos` subpath) can be
 * used without importing kit at runtime, while remaining 100% assignable to kit's type:
 * a transport is just an async function from a JSON-RPC payload to its parsed response.
 */
export type RpcTransport = <TResponse>(
  config: Readonly<{ payload: unknown; signal?: AbortSignal }>,
) => Promise<TResponse>;

/** The JSON-RPC request envelope kit sends through a transport. */
export interface JsonRpcPayload {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export function isJsonRpcPayload(payload: unknown): payload is JsonRpcPayload {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as JsonRpcPayload).jsonrpc === '2.0' &&
    typeof (payload as JsonRpcPayload).method === 'string'
  );
}

/** A JSON-RPC response envelope carrying an error instead of a result. */
export interface JsonRpcErrorResponse {
  readonly error: { readonly code: number; readonly message?: string; readonly data?: unknown };
}

export function isJsonRpcErrorResponse(value: unknown): value is JsonRpcErrorResponse {
  if (typeof value !== 'object' || value === null) return false;
  const error = (value as JsonRpcErrorResponse).error;
  return typeof error === 'object' && error !== null && typeof error.code === 'number';
}

export type FailureKind = 'network' | 'timeout' | 'http' | 'rpc' | 'abort' | 'unknown';

/**
 * Every failure observed by the transport stack is normalized into this shape.
 * It drives all downstream policy: whether to retry, whether to prefer another
 * endpoint, whether to cool an endpoint down, and how to score health.
 */
export interface ClassifiedFailure {
  readonly kind: FailureKind;
  /** Another attempt may succeed (on this or another endpoint). */
  readonly retryable: boolean;
  /** This endpoint is at fault — prefer a different one for the next attempt. */
  readonly rotateEndpoint: boolean;
  /**
   * The endpoint is misconfigured (bad API key, wrong URL): exclude it from
   * selection entirely rather than cycling it through the circuit breaker.
   * Retrying is still allowed on *other* endpoints.
   */
  readonly markDead: boolean;
  /** Endpoint should not be used again before this many milliseconds (e.g. Retry-After). */
  readonly cooldownMs?: number;
  readonly httpStatus?: number;
  readonly rpcErrorCode?: number;
  readonly message: string;
  readonly cause: unknown;
}

/** Thrown by shield middlewares when a per-attempt timeout elapses. */
export class TransportTimeoutError extends Error {
  override readonly name = 'TransportTimeoutError';
  constructor(readonly timeoutMs: number) {
    super(`RPC request timed out after ${timeoutMs}ms`);
  }
}

/** Thrown when every attempt has been exhausted; carries the per-attempt failures. */
export class AllEndpointsFailedError extends Error {
  override readonly name = 'AllEndpointsFailedError';
  /** A plain-language suggestion for what to do, derived from the failures. */
  readonly remediation: string;
  constructor(readonly failures: readonly ClassifiedFailure[]) {
    const remediation = suggestRemediation(failures);
    super(
      `All RPC attempts failed (${failures.length} attempt${failures.length === 1 ? '' : 's'}): ` +
        failures.map(f => f.message).join('; ') +
        (remediation ? `\n→ ${remediation}` : ''),
    );
    this.remediation = remediation;
  }
}

/**
 * Turn a set of classified failures into an actionable hint. Beats throwing a
 * raw RPC error: it tells the developer what was tried and what to do next.
 */
export function suggestRemediation(failures: readonly ClassifiedFailure[]): string {
  if (failures.length === 0) return '';
  const every = (pred: (f: ClassifiedFailure) => boolean): boolean => failures.every(pred);
  const some = (pred: (f: ClassifiedFailure) => boolean): boolean => failures.some(pred);
  const isRateLimited = (f: ClassifiedFailure): boolean =>
    f.httpStatus === 429 || /rate limit/i.test(f.message);

  if (some(f => f.markDead)) {
    return 'an endpoint rejected authentication (401/403) or was not found (404) — check the API key and URL for the failing endpoint(s).';
  }
  if (every(isRateLimited)) {
    return 'every endpoint is rate-limiting (429) — add more endpoints, set a per-endpoint `rps` cap to stay under the limit, or raise your provider tier.';
  }
  if (every(f => f.kind === 'network' || f.kind === 'timeout')) {
    return 'every endpoint was unreachable or timed out — check network connectivity and the endpoint URLs, or raise `requestTimeoutMs`.';
  }
  if (every(f => f.kind === 'rpc')) {
    return 'every endpoint returned node-health errors (behind/unavailable) — your nodes may be lagging the cluster; add a healthier endpoint.';
  }
  return 'add more healthy endpoints, or inspect the per-attempt failures above for the dominant cause.';
}
