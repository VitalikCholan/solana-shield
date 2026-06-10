import type { FaultPlan } from './chaos-transport.js';

/**
 * Preset fault plans modeling failure modes Solana dApps actually encounter.
 * Use them directly or spread-and-tweak: `{ ...scenarios.degradedProvider, seed: 7 }`.
 */
export const scenarios = {
  /** A provider having a bad day: slow, occasionally dropping or erroring. */
  degradedProvider: {
    seed: 42,
    latency: { meanMs: 800, jitterMs: 400, distribution: 'pareto' },
    dropRate: 0.15,
    httpErrors: [{ status: 502, rate: 0.1 }],
  },

  /** Free-tier rate limiting: bursts of 429s with Retry-After. */
  rateLimitStorm: {
    seed: 42,
    httpErrors: [{ status: 429, rate: 0.5, retryAfterMs: 2000 }],
  },

  /** A node that responds quickly but has fallen behind the cluster. */
  laggingNode: {
    seed: 42,
    rpcErrors: [{ code: -32005, message: 'Node is behind by 142 slots', rate: 0.7 }],
  },

  /** Regional outage: hard down for 5s windows, then back for 10s. */
  regionalOutage: {
    seed: 42,
    flapping: { upMs: 10_000, downMs: 5_000 },
  },

  /** Total partition that heals after 5 seconds (breaker-recovery exercise). */
  recoveringPartition: {
    seed: 42,
    dropRate: 1,
    schedule: [{ afterMs: 5_000, plan: { dropRate: 0 } }],
  },

  /** Requests neither fail nor complete in reasonable time. */
  slowLoris: {
    seed: 42,
    slowLoris: { rate: 0.5, hangMs: 30_000 },
  },
} as const satisfies Record<string, FaultPlan>;
