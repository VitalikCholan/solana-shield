import type { TransportMiddleware } from './stack.js';
import type { RpcTransport } from './types.js';
import { isJsonRpcPayload } from './types.js';

/** Read methods safe to coalesce (same response for identical params). */
export const COALESCEABLE_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'getVersion',
]);

export interface CoalescingOptions {
  readonly methods?: ReadonlySet<string>;
}

interface InFlight {
  readonly promise: Promise<unknown>;
  readonly controller: AbortController;
  refs: number;
}

/**
 * In-flight request deduplication: identical concurrent reads share a single
 * underlying request. Reference-counted aborts — the shared request is only
 * cancelled when *every* subscriber has aborted; a single subscriber aborting
 * still gets its own rejection without disturbing the others.
 */
export function createCoalescingMiddleware(options: CoalescingOptions = {}): TransportMiddleware {
  const methods = options.methods ?? COALESCEABLE_METHODS;
  const inFlight = new Map<string, InFlight>();

  return (next: RpcTransport): RpcTransport =>
    (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
      const payload = config.payload;
      if (!isJsonRpcPayload(payload) || !methods.has(payload.method)) {
        return next(config);
      }
      config.signal?.throwIfAborted();
      const key = `${payload.method}:${stableStringify(payload.params)}`;

      let entry = inFlight.get(key);
      if (!entry) {
        const controller = new AbortController();
        // Re-id the payload so the shared response is valid for every subscriber.
        const promise = next({ payload, signal: controller.signal }).finally(() => {
          if (inFlight.get(key) === entry) inFlight.delete(key);
        });
        promise.catch(() => {}); // every subscriber observes via subscribe(); avoid unhandled noise
        entry = { promise, controller, refs: 0 };
        inFlight.set(key, entry);
      }
      return subscribe(entry, config.signal);
    }) as RpcTransport;
}

function subscribe(entry: InFlight, signal: AbortSignal | undefined): Promise<unknown> {
  entry.refs += 1;
  if (!signal) {
    return entry.promise;
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      entry.refs -= 1;
      if (entry.refs <= 0) entry.controller.abort(signal.reason);
      reject(toError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    entry.promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : toError(err));
      },
    );
  });
}

/** Deterministic JSON with sorted object keys; bigint-safe. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const record = v as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = record[k];
          return acc;
        }, {});
    }
    return v;
  });
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'Request aborted');
  err.name = 'AbortError';
  return err;
}
