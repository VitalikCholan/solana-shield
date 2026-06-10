import type { TransportMiddleware } from './stack.js';
import type { RpcTransport } from './types.js';
import { isJsonRpcPayload } from './types.js';

/** Idempotent read methods that are safe to hedge. NEVER hedge sendTransaction. */
export const HEDGEABLE_METHODS: ReadonlySet<string> = new Set([
  'getAccountInfo',
  'getBalance',
  'getBlockHeight',
  'getEpochInfo',
  'getFeeForMessage',
  'getHealth',
  'getLatestBlockhash',
  'getMultipleAccounts',
  'getProgramAccounts',
  'getRecentPrioritizationFees',
  'getSignatureStatuses',
  'getSlot',
  'getTokenAccountBalance',
  'getTokenAccountsByOwner',
  'getTransaction',
  'getVersion',
]);

export interface HedgingOptions {
  /**
   * Delay before firing the hedge request. A function lets you derive it from
   * live latency (e.g. `() => Math.max(50, health p95)`). Default 200ms.
   */
  readonly delayMs?: number | (() => number);
  readonly methods?: ReadonlySet<string>;
}

/**
 * Hedged reads: if a hedgeable request hasn't settled within `delayMs`, fire a
 * second identical request (the stack below re-runs endpoint selection, so it
 * lands on a different node with high probability) and take whichever settles
 * first; the loser is aborted. Tames tail latency at the cost of a few extra
 * reads — opt-in.
 */
export function createHedgingMiddleware(options: HedgingOptions = {}): TransportMiddleware {
  const methods = options.methods ?? HEDGEABLE_METHODS;
  const delayOf = typeof options.delayMs === 'function' ? options.delayMs : () => (options.delayMs as number | undefined) ?? 200;

  return (next: RpcTransport): RpcTransport =>
    (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
      const payload = config.payload;
      if (!isJsonRpcPayload(payload) || !methods.has(payload.method)) {
        return next(config);
      }
      const callerSignal = config.signal;
      callerSignal?.throwIfAborted();

      return new Promise<unknown>((resolve, reject) => {
        const controllers: AbortController[] = [];
        let pending = 0;
        let settled = false;
        let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
        let firstError: unknown;

        const cleanup = (): void => {
          if (hedgeTimer !== undefined) clearTimeout(hedgeTimer);
          callerSignal?.removeEventListener('abort', onCallerAbort);
          for (const controller of controllers) controller.abort();
        };
        const onCallerAbort = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(toError(callerSignal?.reason));
        };
        callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

        const launch = (): void => {
          const controller = new AbortController();
          controllers.push(controller);
          pending += 1;
          next({ payload, signal: controller.signal }).then(
            response => {
              if (settled) return;
              settled = true;
              cleanup();
              resolve(response);
            },
            (err: unknown) => {
              pending -= 1;
              if (settled) return;
              firstError ??= err;
              if (hedgeTimer !== undefined && controllers.length === 1) {
                // Primary failed before the hedge fired: fire it now rather
                // than waiting out the timer.
                clearTimeout(hedgeTimer);
                hedgeTimer = undefined;
                launch();
                return;
              }
              if (pending === 0 && (controllers.length === 2 || hedgeTimer === undefined)) {
                settled = true;
                cleanup();
                reject(toError(firstError));
              }
            },
          );
        };

        launch();
        hedgeTimer = setTimeout(() => {
          hedgeTimer = undefined;
          if (!settled) launch();
        }, delayOf());
      });
    }) as RpcTransport;
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const err = new Error(typeof reason === 'string' ? reason : 'Request aborted');
  err.name = 'AbortError';
  return err;
}
