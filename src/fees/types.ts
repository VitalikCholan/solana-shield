export type FeeLevel = 'low' | 'medium' | 'high' | 'veryHigh';

export interface FeeEstimateRequest {
  /** Writable account addresses the transaction touches (fee markets are per-account). */
  readonly writableAddresses: readonly string[];
  /** Fully built transaction (base64 wire format) for sources that can use it. */
  readonly serializedTransactionBase64?: string;
  readonly level: FeeLevel;
}

export interface FeeSourceContext {
  readonly signal?: AbortSignal;
}

/** A priority-fee estimator returning micro-lamports per compute unit. */
export interface FeeSource {
  readonly name: string;
  estimate(request: FeeEstimateRequest, context: FeeSourceContext): Promise<bigint>;
}

export interface FeeEstimate {
  readonly microLamportsPerCu: bigint;
  readonly source: string;
}
