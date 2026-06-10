import type { HealthRegistry } from './health.js';

export interface SlotProbeOptions {
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
}

/**
 * Background slot-lag probe: every `intervalMs`, ask each endpoint for its slot
 * via its raw transport and feed the results to the registry, which converts
 * them to per-endpoint lag relative to the most advanced node in the pool.
 *
 * Probe failures are ignored here — regular traffic already feeds the failure
 * accounting, and a probe miss should not double-penalize an endpoint.
 *
 * Returns a stop function.
 */
export function startSlotProbe(health: HealthRegistry, options: SlotProbeOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? 10_000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  let stopped = false;

  async function probeOnce(): Promise<void> {
    const slots = new Map<string, bigint>();
    await Promise.all(
      health.all().map(async endpoint => {
        if (endpoint.dead) return;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), probeTimeoutMs);
        try {
          const response = await endpoint.transport<{ result?: number | bigint }>({
            payload: {
              id: `shield-slot-probe`,
              jsonrpc: '2.0',
              method: 'getSlot',
              params: [{ commitment: 'confirmed' }],
            },
            signal: controller.signal,
          });
          const result = (response as { result?: number | bigint })?.result;
          if (typeof result === 'bigint') slots.set(endpoint.id, result);
          else if (typeof result === 'number') slots.set(endpoint.id, BigInt(result));
        } catch {
          // ignored — see doc comment
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    if (!stopped && slots.size > 0) health.recordSlots(slots);
  }

  const interval = setInterval(() => void probeOnce(), intervalMs);
  // Don't hold the process open just for the probe (no-op in browsers).
  (interval as unknown as { unref?: () => void }).unref?.();
  void probeOnce();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
