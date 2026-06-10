import type { RpcTransport } from '../../transport/types.js';
import type { FeeEstimateRequest, FeeSource, FeeSourceContext } from '../types.js';

/** Triton percentiles are in basis points of the fee distribution (0–10000). */
const LEVEL_PERCENTILE: Record<FeeEstimateRequest['level'], number> = {
  low: 2500,
  medium: 5000,
  high: 7500,
  veryHigh: 9500,
};

interface TritonResponse {
  readonly result?: ReadonlyArray<{
    readonly slot: number | bigint;
    readonly prioritizationFee: number | bigint;
  }>;
  readonly error?: { readonly code: number; readonly message?: string };
}

/**
 * Triton's enhanced `getRecentPrioritizationFees` with the `percentile`
 * extension — pointed at a Triton One endpoint. Returns the median across
 * recent slots of the requested percentile fee.
 */
export function createTritonFeeSource(transport: RpcTransport): FeeSource {
  return {
    name: 'triton',
    async estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint> {
      const response = await transport<TritonResponse>({
        payload: {
          id: 'shield-fee-triton',
          jsonrpc: '2.0',
          method: 'getRecentPrioritizationFees',
          params: [
            request.writableAddresses.slice(0, 128),
            { percentile: LEVEL_PERCENTILE[request.level] },
          ],
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!Array.isArray(response?.result)) {
        throw new Error(
          `triton: unexpected getRecentPrioritizationFees response${response?.error ? `: ${response.error.message ?? response.error.code}` : ''}`,
        );
      }
      const fees = response.result
        .map(entry => BigInt(entry.prioritizationFee))
        .filter(fee => fee > 0n)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      if (fees.length === 0) return 1n;
      return fees[Math.floor(fees.length / 2)] ?? 1n;
    },
  };
}
