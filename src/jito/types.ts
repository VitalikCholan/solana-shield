/**
 * What the transaction pipeline needs from a Jito sender. The concrete
 * implementation lives in `solana-shield/jito`; the pipeline depends only on
 * this interface so it can be tested (and tree-shaken) independently.
 */
export interface JitoSenderLike {
  /** Submit a base64-encoded signed transaction to the block engine. */
  sendTransaction(wireTransactionBase64: string, opts?: { signal?: AbortSignal }): Promise<void>;
  /** Current recommended tip in lamports (≥ 1000, tracks the live tip floor). */
  recommendedTipLamports(opts?: { signal?: AbortSignal }): Promise<bigint>;
  /** A randomly chosen Jito tip account address. */
  randomTipAccount(opts?: { signal?: AbortSignal }): Promise<string>;
  /** Label for telemetry/events (e.g. "jito:frankfurt"). */
  readonly label: string;
}
