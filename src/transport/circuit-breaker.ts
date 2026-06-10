export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerOptions {
  /** Rotate-class failures within `windowMs` that trip the breaker. */
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  /** First open duration; doubles per consecutive trip up to `maxOpenMs`. */
  readonly baseOpenMs?: number;
  readonly maxOpenMs?: number;
  readonly now?: () => number;
}

/**
 * Per-endpoint three-state circuit breaker.
 *
 * closed → open after `failureThreshold` failures inside `windowMs`;
 * open → half-open once the open period elapses (exponential per trip, capped);
 * half-open admits exactly one probe — success closes, failure reopens.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly baseOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;

  private failureTimes: number[] = [];
  private openUntil = 0;
  private opened = false;
  private trips = 0;
  private probeInFlight = false;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.windowMs = options.windowMs ?? 30_000;
    this.baseOpenMs = options.baseOpenMs ?? 10_000;
    this.maxOpenMs = options.maxOpenMs ?? 300_000;
    this.now = options.now ?? Date.now;
  }

  state(): BreakerState {
    if (!this.opened) return 'closed';
    return this.now() < this.openUntil ? 'open' : 'half-open';
  }

  /** Whether a request may be sent right now. In half-open, only one probe is admitted. */
  tryAcquire(): boolean {
    switch (this.state()) {
      case 'closed':
        return true;
      case 'open':
        return false;
      case 'half-open':
        if (this.probeInFlight) return false;
        this.probeInFlight = true;
        return true;
    }
  }

  recordSuccess(): void {
    this.failureTimes = [];
    this.opened = false;
    this.trips = 0;
    this.probeInFlight = false;
  }

  /** Record a rotate-class failure (endpoint's fault). */
  recordFailure(): void {
    const now = this.now();
    if (this.opened) {
      // Failed half-open probe: reopen with a longer period.
      this.trips += 1;
      this.openUntil = now + Math.min(this.maxOpenMs, this.baseOpenMs * 2 ** (this.trips - 1));
      this.probeInFlight = false;
      return;
    }
    this.failureTimes.push(now);
    this.failureTimes = this.failureTimes.filter(t => now - t <= this.windowMs);
    if (this.failureTimes.length >= this.failureThreshold) {
      this.opened = true;
      this.trips += 1;
      this.openUntil = now + Math.min(this.maxOpenMs, this.baseOpenMs * 2 ** (this.trips - 1));
      this.failureTimes = [];
      this.probeInFlight = false;
    }
  }

  /**
   * Force the breaker into half-open so a probe can be admitted immediately.
   * Used by the selector when every endpoint is open — there must always be
   * something to try, otherwise a total-outage recovery would deadlock.
   */
  forceHalfOpen(): void {
    if (!this.opened) return;
    this.openUntil = this.now();
    this.probeInFlight = false;
  }
}
