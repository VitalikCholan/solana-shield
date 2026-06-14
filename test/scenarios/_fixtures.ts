/** Shared fixtures for the resilience scenario suite. */
import { getBase58Decoder } from '@solana/kit';
import type { FeeSource } from '../../src/fees/types.js';

export const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(8));
export const CONFIRMED_SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

export const stubFeeSource: FeeSource = { name: 'stub', estimate: async () => 100n };

/** Healthy RPC node handlers; `confirmAfterPolls` controls when a tx "lands". */
export function nodeHandlers(
  options: { confirmAfterPolls?: number; blockHeight?: bigint | ((p: unknown, i: number) => bigint) } = {},
) {
  const confirmAfter = options.confirmAfterPolls ?? 0;
  return {
    getLatestBlockhash: {
      context: { slot: 1n },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
    },
    simulateTransaction: {
      context: { slot: 1n },
      value: { err: null, logs: [], unitsConsumed: 20_000n, accounts: null, returnData: null },
    },
    sendTransaction: CONFIRMED_SIG,
    getSignatureStatuses: (_p: unknown, i: number) =>
      i < confirmAfter
        ? { context: { slot: 100n }, value: [null] }
        : {
            context: { slot: 100n },
            value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
          },
    getBlockHeight: options.blockHeight ?? 500n,
  };
}
