/**
 * mulberry32 — tiny, fast, seedable PRNG. Chaos runs seeded with the same value
 * reproduce the exact same fault sequence, which is what keeps the scenario
 * test suite deterministic instead of flaky.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller, driven by the supplied uniform PRNG. */
export function gaussian(random: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/** Pareto-distributed sample with shape alpha and minimum 1 (heavy tail ≈ real network latency). */
export function pareto(random: () => number, alpha = 2): number {
  let u = 0;
  while (u === 0) u = random();
  return 1 / Math.pow(u, 1 / alpha);
}
