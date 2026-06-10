import type { Signature } from '@solana/kit';

/**
 * The transaction's blockhash lifetime ended without a confirmation. The
 * transaction may be safely rebuilt and re-signed — it can no longer land.
 */
export class TxExpiredError extends Error {
  override readonly name = 'TxExpiredError';
  constructor(
    readonly signature: Signature,
    readonly lastValidBlockHeight: bigint,
    readonly blockHeight: bigint,
  ) {
    super(
      `Transaction ${signature} expired: block height ${blockHeight} passed lastValidBlockHeight ${lastValidBlockHeight}`,
    );
  }
}

/** The transaction landed on chain but failed during execution. */
export class TxFailedError extends Error {
  override readonly name = 'TxFailedError';
  constructor(
    readonly signature: Signature | undefined,
    readonly error: unknown,
  ) {
    super(`Transaction ${signature ?? '(unsigned)'} failed: ${stringifyTxError(error)}`);
  }
}

export function stringifyTxError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(error);
  }
}
