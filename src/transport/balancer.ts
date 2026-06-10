import type { EndpointState, HealthRegistry } from './health.js';

/**
 * Endpoint selection: weighted power-of-two-choices.
 *
 * Two candidates are sampled at random, weighted by `configWeight * healthScore`,
 * and the higher-scored of the two wins. This spreads load like weighted random
 * (no thundering herd onto the single best node) while still steering most
 * traffic away from degraded endpoints.
 */
export class EndpointSelector {
  constructor(
    private readonly registry: HealthRegistry,
    private readonly random: () => number = Math.random,
  ) {}

  /**
   * Select an endpoint for the next attempt.
   *
   * `exclude` holds endpoint ids already tried for this logical request; they are
   * avoided when possible but reused when nothing else is available. If every
   * endpoint is unavailable (breakers open / cooldowns), the best-scored non-dead
   * endpoint is force-half-opened so recovery from a total outage cannot deadlock.
   */
  select(exclude: ReadonlySet<string> = new Set()): EndpointState | undefined {
    let pool = this.registry.available().filter(e => !exclude.has(e.id));
    if (pool.length === 0) pool = this.registry.available();
    if (pool.length === 0) {
      const fallback = this.bestUnavailable(exclude);
      if (fallback) {
        fallback.breaker.forceHalfOpen();
        return fallback;
      }
      return undefined;
    }
    return this.pickPowerOfTwo(pool);
  }

  private bestUnavailable(exclude: ReadonlySet<string>): EndpointState | undefined {
    // Prefer non-dead endpoints; among the dead, anything beats deadlocking.
    const all = this.registry.all();
    const rank = (candidates: EndpointState[]) =>
      candidates.sort((a, b) => b.score() - a.score())[0];
    const alive = all.filter(e => !e.dead);
    const aliveFresh = alive.filter(e => !exclude.has(e.id));
    return rank(aliveFresh) ?? rank(alive) ?? rank(all.filter(e => !exclude.has(e.id))) ?? rank(all);
  }

  private pickPowerOfTwo(pool: EndpointState[]): EndpointState {
    if (pool.length === 1) return pool[0]!;
    const first = this.weightedSample(pool);
    const rest = pool.filter(e => e !== first);
    const second = this.weightedSample(rest);
    return second.score() > first.score() ? second : first;
  }

  private weightedSample(pool: EndpointState[]): EndpointState {
    const weights = pool.map(e => Math.max(1e-6, e.weight * e.score()));
    const total = weights.reduce((a, b) => a + b, 0);
    let target = this.random() * total;
    for (let i = 0; i < pool.length; i++) {
      target -= weights[i]!;
      if (target <= 0) return pool[i]!;
    }
    return pool[pool.length - 1]!;
  }
}
