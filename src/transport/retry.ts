export interface RetryPolicy {
  /** Total attempts including the first (default 4). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 8000,
};

/**
 * Exponential backoff with full jitter: uniform in [0, min(maxDelay, base * 2^attempt)].
 * Full jitter avoids retry herds when many clients fail simultaneously.
 *
 * @param attempt zero-based index of the attempt that just failed
 */
export function computeBackoffMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}
