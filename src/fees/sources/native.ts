import type { GetRecentPrioritizationFeesApi, Rpc } from '@solana/kit';
import type { FeeEstimateRequest, FeeSource, FeeSourceContext } from '../types.js';

/** Quantile of recent fees used per level. */
const LEVEL_QUANTILE: Record<FeeEstimateRequest['level'], number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  veryHigh: 0.95,
};

/**
 * Universal fallback fee source: `getRecentPrioritizationFees` over the
 * transaction's writable accounts, taking a per-level quantile of the nonzero
 * fees from the last 150 slots. Works on every RPC provider.
 */
export function createNativeFeeSource(rpc: Rpc<GetRecentPrioritizationFeesApi>): FeeSource {
  return {
    name: 'native',
    async estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint> {
      const addresses = request.writableAddresses.slice(0, 128); // RPC caps account list length
      const fees = await rpc
        .getRecentPrioritizationFees(
          addresses as unknown as Parameters<
            Rpc<GetRecentPrioritizationFeesApi>['getRecentPrioritizationFees']
          >[0],
        )
        .send(context.signal ? { abortSignal: context.signal } : undefined);
      const nonzero = fees
        .map(f => f.prioritizationFee)
        .filter(fee => fee > 0n)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (nonzero.length === 0) return 1n;
      const index = Math.min(
        nonzero.length - 1,
        Math.max(0, Math.ceil(LEVEL_QUANTILE[request.level] * nonzero.length) - 1),
      );
      return nonzero[index] ?? 1n;
    },
  };
}
