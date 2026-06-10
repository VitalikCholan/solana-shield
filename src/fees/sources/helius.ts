import type { RpcTransport } from '../../transport/types.js';
import type { FeeEstimateRequest, FeeSource, FeeSourceContext } from '../types.js';

const LEVEL_MAP: Record<FeeEstimateRequest['level'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  veryHigh: 'VeryHigh',
};

interface HeliusResponse {
  readonly result?: { readonly priorityFeeEstimate?: number };
  readonly error?: { readonly code: number; readonly message?: string };
}

/**
 * Helius Priority Fee API (`getPriorityFeeEstimate`) — must be pointed at a
 * Helius RPC endpoint; the method is provider-specific.
 */
export function createHeliusFeeSource(transport: RpcTransport): FeeSource {
  return {
    name: 'helius',
    async estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint> {
      const response = await transport<HeliusResponse>({
        payload: {
          id: 'shield-fee-helius',
          jsonrpc: '2.0',
          method: 'getPriorityFeeEstimate',
          params: [
            {
              accountKeys: request.writableAddresses.slice(0, 128),
              options: { priorityLevel: LEVEL_MAP[request.level] },
            },
          ],
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const estimate = response?.result?.priorityFeeEstimate;
      if (typeof estimate !== 'number' || !Number.isFinite(estimate)) {
        throw new Error(
          `helius: unexpected getPriorityFeeEstimate response${response?.error ? `: ${response.error.message ?? response.error.code}` : ''}`,
        );
      }
      return BigInt(Math.max(0, Math.ceil(estimate)));
    },
  };
}
