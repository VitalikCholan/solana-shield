import type { ClassifiedFailure, FailureKind } from './types.js';
import { TransportTimeoutError, isJsonRpcErrorResponse } from './types.js';

/**
 * Failure classification — the policy table the whole resilience stack runs on.
 *
 * `retryable`      → may another attempt succeed at all?
 * `rotateEndpoint` → is this endpoint's fault (prefer another on the next attempt)?
 * `markDead`       → endpoint is misconfigured (bad key/URL); exclude it outright.
 */

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * JSON-RPC error codes indicating the *node* is unhealthy or lagging — another
 * node can serve the same request. Everything else in the JSON-RPC error space
 * is treated as an application-level result and passed through to the caller.
 *
 * -32004 block not available; -32005 node unhealthy/behind; -32008 no snapshot;
 * -32010 index key excluded (node config); -32011 tx history unavailable (node config);
 * -32014 block status not yet available; -32016 minContextSlot not reached.
 */
const NODE_HEALTH_RPC_CODES = new Set([-32004, -32005, -32008, -32010, -32011, -32014, -32016]);

const RATE_LIMIT_MESSAGE = /rate.?limit|too many requests/i;

interface ClassifyOptions {
  /** Marks our own per-attempt timeout aborts (vs caller-initiated aborts). */
  readonly timedOut?: boolean;
}

function failure(
  kind: FailureKind,
  cause: unknown,
  message: string,
  flags: { retryable: boolean; rotateEndpoint: boolean; markDead?: boolean },
  extra: { cooldownMs?: number; httpStatus?: number; rpcErrorCode?: number } = {},
): ClassifiedFailure {
  return {
    kind,
    retryable: flags.retryable,
    rotateEndpoint: flags.rotateEndpoint,
    markDead: flags.markDead ?? false,
    message,
    cause,
    ...(extra.cooldownMs !== undefined ? { cooldownMs: extra.cooldownMs } : {}),
    ...(extra.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    ...(extra.rpcErrorCode !== undefined ? { rpcErrorCode: extra.rpcErrorCode } : {}),
  };
}

/** Classify an error thrown by a transport call. */
export function classifyFailure(err: unknown, options: ClassifyOptions = {}): ClassifiedFailure {
  if (err instanceof TransportTimeoutError) {
    return failure('timeout', err, err.message, { retryable: true, rotateEndpoint: true });
  }

  const name = errorName(err);
  if (name === 'TimeoutError' || (name === 'AbortError' && options.timedOut)) {
    return failure('timeout', err, errorMessage(err), { retryable: true, rotateEndpoint: true });
  }
  if (name === 'AbortError') {
    // Caller-initiated abort: never retry, never blame the endpoint.
    return failure('abort', err, errorMessage(err), { retryable: false, rotateEndpoint: false });
  }

  const httpStatus = extractHttpStatus(err);
  if (httpStatus !== undefined) {
    return classifyHttpStatus(httpStatus, err, extractRetryAfterMs(err));
  }

  if (isNetworkError(err)) {
    return failure('network', err, errorMessage(err), { retryable: true, rotateEndpoint: true });
  }

  // Unknown error shape: likely a bug in user code or a non-transient condition.
  return failure('unknown', err, errorMessage(err), { retryable: false, rotateEndpoint: false });
}

/** Classify an HTTP status code (also reused by the Jito sender, which speaks raw fetch). */
export function classifyHttpStatus(
  status: number,
  cause: unknown,
  retryAfterMs?: number,
): ClassifiedFailure {
  const message = `HTTP ${status}`;
  if (status === 429) {
    return failure(
      'http',
      cause,
      `${message} (rate limited)`,
      { retryable: true, rotateEndpoint: true },
      retryAfterMs !== undefined
        ? { httpStatus: status, cooldownMs: retryAfterMs }
        : { httpStatus: status },
    );
  }
  if (status === 401 || status === 403) {
    return failure(
      'http',
      cause,
      `${message} (authentication/authorization failed — check this endpoint's API key)`,
      { retryable: false, rotateEndpoint: true, markDead: true },
      { httpStatus: status },
    );
  }
  if (status === 404 || status === 410) {
    return failure(
      'http',
      cause,
      `${message} (endpoint URL appears wrong)`,
      { retryable: false, rotateEndpoint: true, markDead: true },
      { httpStatus: status },
    );
  }
  if (status === 408 || status >= 500) {
    return failure(
      'http',
      cause,
      `${message} (server error)`,
      { retryable: true, rotateEndpoint: true },
      { httpStatus: status },
    );
  }
  // Remaining 4xx: the request itself is malformed — retrying anywhere won't help.
  return failure(
    'http',
    cause,
    `${message} (client error)`,
    { retryable: false, rotateEndpoint: false },
    { httpStatus: status },
  );
}

/**
 * Inspect a *successful* transport response for JSON-RPC errors that indicate the
 * node (rather than the request) is at fault. Returns `undefined` for results and
 * for application-level errors, which must flow through to the caller untouched.
 */
export function classifyRpcErrorResponse(response: unknown): ClassifiedFailure | undefined {
  if (!isJsonRpcErrorResponse(response)) return undefined;
  const { code, message = '' } = response.error;
  if (NODE_HEALTH_RPC_CODES.has(code)) {
    return failure(
      'rpc',
      response,
      `JSON-RPC ${code}: ${message} (node unhealthy)`,
      { retryable: true, rotateEndpoint: true },
      { rpcErrorCode: code },
    );
  }
  if (RATE_LIMIT_MESSAGE.test(message)) {
    return failure(
      'rpc',
      response,
      `JSON-RPC ${code}: ${message} (rate limited)`,
      { retryable: true, rotateEndpoint: true },
      { rpcErrorCode: code },
    );
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Error-shape extraction (duck-typed: kit's SolanaError, undici, plain fetch)
// ---------------------------------------------------------------------------

function errorName(err: unknown): string | undefined {
  return err instanceof Error || (typeof err === 'object' && err !== null && 'name' in err)
    ? String((err as Error).name)
    : undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : JSON.stringify(err) ?? String(err);
}

/**
 * Pull an HTTP status out of a thrown error. Kit's HTTP transport throws
 * `SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { statusCode, headers, message })`
 * where the context lands on `err.context`; other libraries use `status`/`statusCode`.
 */
function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidates = [
    (err as { context?: { statusCode?: unknown } }).context?.statusCode,
    (err as { statusCode?: unknown }).statusCode,
    (err as { status?: unknown }).status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}

/** Parse a Retry-After header (seconds or HTTP-date) from kit/fetch error shapes. */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const headers =
    (err as { context?: { headers?: unknown } }).context?.headers ??
    (err as { headers?: unknown }).headers;
  const raw = readHeader(headers, 'retry-after');
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

function readHeader(headers: unknown, key: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(key) ?? undefined;
  }
  const record = headers as Record<string, unknown>;
  for (const k of Object.keys(record)) {
    if (k.toLowerCase() === key) {
      const v = record[k];
      return typeof v === 'string' ? v : undefined;
    }
  }
  return undefined;
}

function isNetworkError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === 'object' && cause !== null) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && NETWORK_ERROR_CODES.has(causeCode)) return true;
  }
  // `fetch` rejects with a TypeError on network failure in both undici and browsers.
  if (err instanceof TypeError) return true;
  const message = errorMessage(err);
  return /fetch failed|network|socket hang up/i.test(message);
}
