import { sleep } from '../internal/async.js';

export interface RebroadcastOptions {
  /** Re-sends the identical signed bytes; `attempt` is 1-based. */
  readonly send: (attempt: number) => Promise<void>;
  readonly intervalMs?: number;
  readonly signal: AbortSignal;
  readonly onResent?: (attempt: number) => void;
  readonly onError?: (attempt: number, error: unknown) => void;
}

/**
 * Rebroadcast loop: re-sends the same signed transaction every `intervalMs`
 * until aborted (confirmation, expiry, or caller cancel). Send errors are
 * reported but never stop the loop — the next tick simply tries again.
 *
 * Resending identical bytes is always safe: a transaction is identified by its
 * signature, so duplicates are idempotent on chain.
 */
export function startRebroadcast(options: RebroadcastOptions): Promise<void> {
  const intervalMs = options.intervalMs ?? 2500;
  return (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        await sleep(intervalMs, options.signal);
      } catch {
        return; // aborted
      }
      try {
        await options.send(attempt);
        options.onResent?.(attempt);
      } catch (err) {
        if (options.signal.aborted) return;
        options.onError?.(attempt, err);
      }
    }
  })();
}
