/**
 * Token bucket for proactive request-rate caps (e.g. free provider tiers, or
 * Jito's documented 1 req/s/region limit). Reactive 429 cooldowns are handled
 * separately via `EndpointState.setCooldown`.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, ratePerSecond),
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = this.burst;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const current = this.now();
    const elapsed = (current - this.lastRefill) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
      this.lastRefill = current;
    }
  }

  /** Take a token if available. */
  tryRemove(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  /** Milliseconds until the next token becomes available (0 if available now). */
  msUntilAvailable(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.ratePerSecond) * 1000);
  }
}

/**
 * Default cooldown for a 429 with no Retry-After header: exponential per
 * consecutive rate-limit hit, capped.
 */
export function defaultRateLimitCooldownMs(consecutiveHits: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, consecutiveHits - 1));
}
