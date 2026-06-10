import type { RpcTransport } from '../../transport/types.js';
import type { FeeEstimateRequest, FeeSource, FeeSourceContext } from '../types.js';

const LEVEL_MAP: Record<FeeEstimateRequest['level'], 'low' | 'medium' | 'high' | 'extreme'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  veryHigh: 'extreme',
};

interface QuickNodeResponse {
  readonly result?: {
    readonly per_compute_unit?: Partial<Record<'low' | 'medium' | 'high' | 'extreme', number>>;
  };
  readonly error?: { readonly code: number; readonly message?: string };
}

/**
 * QuickNode Priority Fee API (`qn_estimatePriorityFees`) — requires the
 * Priority Fee add-on enabled on the QuickNode endpoint.
 */
export function createQuickNodeFeeSource(transport: RpcTransport): FeeSource {
  return {
    name: 'quicknode',
    async estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint> {
      const response = await transport<QuickNodeResponse>({
        payload: {
          id: 'shield-fee-quicknode',
          jsonrpc: '2.0',
          method: 'qn_estimatePriorityFees',
          params: {
            last_n_blocks: 100,
            api_version: 2,
            ...(request.writableAddresses[0] ? { account: request.writableAddresses[0] } : {}),
          },
        },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      const estimate = response?.result?.per_compute_unit?.[LEVEL_MAP[request.level]];
      if (typeof estimate !== 'number' || !Number.isFinite(estimate)) {
        throw new Error(
          `quicknode: unexpected qn_estimatePriorityFees response${response?.error ? `: ${response.error.message ?? response.error.code}` : ''}`,
        );
      }
      return BigInt(Math.max(0, Math.ceil(estimate)));
    },
  };
}
