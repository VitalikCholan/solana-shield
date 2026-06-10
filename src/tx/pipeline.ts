import type {
  Address,
  Commitment,
  GetBlockHeightApi,
  GetLatestBlockhashApi,
  GetSignatureStatusesApi,
  Instruction,
  Rpc,
  SendTransactionApi,
  Signature,
  SimulateTransactionApi,
  TransactionSigner,
} from '@solana/kit';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionMessageWithSingleSendingSigner,
  createTransactionMessage,
  estimateComputeUnitLimitFactory,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  isTransactionModifyingSigner,
  isTransactionPartialSigner,
  isWritableRole,
  pipe,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { FeeLevel, FeeSource } from '../fees/types.js';
import type { JitoSenderLike } from '../jito/types.js';
import type { MetricsRegistry } from '../telemetry/registry.js';
import type { ConfirmationResult, SignatureSubscriptionsClient } from './confirm.js';
import { confirmSignature } from './confirm.js';
import { TxExpiredError, TxFailedError } from './errors.js';
import type { TxConfirmedEvent, TxStatusEvent } from './events.js';
import { EventStream } from './events.js';
import { startRebroadcast } from './rebroadcast.js';

const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');
const MAX_COMPUTE_UNITS = 1_400_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

export type PipelineRpc = Rpc<
  GetBlockHeightApi &
    GetLatestBlockhashApi &
    GetSignatureStatusesApi &
    SendTransactionApi &
    SimulateTransactionApi
>;

export interface TxPipelineContext {
  readonly rpc: PipelineRpc;
  readonly subscriptions?: readonly SignatureSubscriptionsClient[];
  readonly feeSource: FeeSource;
  readonly jito?: JitoSenderLike;
  readonly metrics?: MetricsRegistry;
}

export interface SendReliablyInput {
  readonly instructions: readonly Instruction[];
  readonly signer: TransactionSigner;
  readonly commitment?: Commitment;
  /** 'auto' (default): Jito first with automatic RPC fallback; or force one route. */
  readonly route?: 'auto' | 'jito' | 'rpc';
  readonly feeLevel?: FeeLevel;
  /** Hard ceiling so a misbehaving fee source can never drain the payer. */
  readonly maxMicroLamportsPerCu?: bigint;
  /** Multiplier applied to the simulated compute unit estimate (default 1.1). */
  readonly computeUnitBuffer?: number;
  /** Explicit Jito tip; defaults to the live recommended tip. */
  readonly jitoTipLamports?: bigint;
  readonly rebroadcastIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly abortSignal?: AbortSignal;
}

export interface ReliableTxHandle extends AsyncIterable<TxStatusEvent> {
  /** Resolves as soon as the transaction is signed. */
  readonly signature: Promise<Signature>;
  /** Resolves on confirmation; rejects with TxExpiredError / TxFailedError. */
  readonly result: Promise<TxConfirmedEvent>;
  abort(): void;
}

/**
 * The reliable send pipeline:
 *
 *   build → estimate fees (oracle) → inject compute budget → (Jito tip) → sign
 *   → send via Jito with automatic RPC fallback → confirm (WS + polling race)
 *   → rebroadcast identical bytes every interval until confirmed or the
 *     blockhash lifetime expires.
 *
 * Expired transactions are NEVER silently rebuilt and re-signed — the caller
 * gets a `TxExpiredError` and decides. (Re-signing without user intent is a
 * correctness hazard, especially for wallet signers.)
 */
export function sendReliably(context: TxPipelineContext, input: SendReliablyInput): ReliableTxHandle {
  const events = new EventStream<TxStatusEvent>();
  const abort = new AbortController();
  if (input.abortSignal) {
    if (input.abortSignal.aborted) abort.abort(input.abortSignal.reason);
    else input.abortSignal.addEventListener('abort', () => abort.abort(input.abortSignal!.reason), { once: true });
  }

  let resolveSignature!: (s: Signature) => void;
  let rejectSignature!: (e: unknown) => void;
  const signature = new Promise<Signature>((resolve, reject) => {
    resolveSignature = resolve;
    rejectSignature = reject;
  });
  let resolveResult!: (e: TxConfirmedEvent) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<TxConfirmedEvent>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Callers may consume only the event stream; don't let the promises trigger
  // unhandled-rejection noise on failure paths they observe via events.
  signature.catch(() => {});
  result.catch(() => {});

  void runPipeline(context, input, {
    events,
    signal: abort.signal,
    onSigned: resolveSignature,
    onConfirmed: resolveResult,
    onError: err => {
      rejectSignature(err);
      rejectResult(err);
    },
  });

  return {
    signature,
    result,
    abort: () => abort.abort(new Error('Transaction send aborted by caller')),
    [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
  };
}

interface PipelineSink {
  readonly events: EventStream<TxStatusEvent>;
  readonly signal: AbortSignal;
  onSigned(signature: Signature): void;
  onConfirmed(event: TxConfirmedEvent): void;
  onError(error: unknown): void;
}

async function runPipeline(
  context: TxPipelineContext,
  input: SendReliablyInput,
  sink: PipelineSink,
): Promise<void> {
  const { events, signal } = sink;
  const commitment = input.commitment ?? 'confirmed';
  const route = input.route ?? 'auto';
  const startedAt = Date.now();
  let signatureForFailure: Signature | undefined;

  try {
    events.push({ type: 'building' });

    const { value: latest } = await context.rpc
      .getLatestBlockhash({ commitment })
      .send({ abortSignal: signal });

    let message = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayerSigner(input.signer, m),
      m => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      m => appendTransactionMessageInstructions(input.instructions, m),
    );

    const ownsBytes =
      isTransactionModifyingSigner(input.signer) || isTransactionPartialSigner(input.signer);
    const jito = context.jito;
    const wantJito = route !== 'rpc' && jito !== undefined;
    const useJito = wantJito && ownsBytes;

    if (route === 'jito' && !jito) {
      throw new Error("route 'jito' requested but no Jito sender is configured");
    }
    if (wantJito && !ownsBytes) {
      events.push({ type: 'jitoFallback', reason: 'signerCannotExportBytes' });
    }

    if (useJito) {
      const tipLamports =
        input.jitoTipLamports ?? (await jito.recommendedTipLamports({ signal }));
      const tipAccount = address(await jito.randomTipAccount({ signal }));
      message = appendTransactionMessageInstructions(
        [transferInstruction(input.signer.address, tipAccount, tipLamports)],
        message,
      );
    }

    // --- fees ---
    const writableAddresses = collectWritableAddresses(message);
    let microLamportsPerCu = 1n;
    let feeSourceName = 'default';
    try {
      microLamportsPerCu = await context.feeSource.estimate(
        { writableAddresses, level: input.feeLevel ?? 'medium' },
        { signal },
      );
      feeSourceName = context.feeSource.name;
    } catch {
      // A fee-oracle outage must never block the send; 1 µlamport still lands
      // in calm conditions and the caller sees the source in the event.
    }
    const ceiling = input.maxMicroLamportsPerCu ?? 5_000_000n;
    if (microLamportsPerCu > ceiling) microLamportsPerCu = ceiling;
    message = setTransactionMessageComputeUnitPrice(microLamportsPerCu, message);

    let computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT;
    try {
      const estimated = await estimateComputeUnitLimitFactory({ rpc: context.rpc })(message, {
        abortSignal: signal,
        commitment,
      });
      const buffer = input.computeUnitBuffer ?? 1.1;
      computeUnitLimit = Math.min(MAX_COMPUTE_UNITS, Math.ceil(estimated * buffer));
    } catch {
      // Simulation can fail for state-dependent transactions; fall back to the
      // default limit rather than blocking the send.
    }
    message = setTransactionMessageComputeUnitLimit(computeUnitLimit, message);
    events.push({
      type: 'feeEstimated',
      microLamportsPerCu,
      computeUnitLimit,
      source: feeSourceName,
    });

    // --- sign + send ---
    let txSignature: Signature;
    let stopRebroadcast: (() => void) | undefined;

    if (ownsBytes) {
      const transaction = await signTransactionMessageWithSigners(message);
      txSignature = getSignatureFromTransaction(transaction);
      signatureForFailure = txSignature;
      events.push({ type: 'signed', signature: txSignature });
      sink.onSigned(txSignature);

      const wire = getBase64EncodedWireTransaction(transaction);
      const sendOnce = async (preferJito: boolean): Promise<'jito' | 'rpc'> => {
        if (preferJito && useJito) {
          try {
            await jito.sendTransaction(wire, { signal });
            return 'jito';
          } catch (err) {
            events.push({
              type: 'jitoFallback',
              reason: 'jitoSendFailed',
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await context.rpc
          .sendTransaction(wire, {
            encoding: 'base64',
            maxRetries: 0n,
            skipPreflight: true,
          })
          .send({ abortSignal: signal });
        return 'rpc';
      };

      const via = await sendOnce(true);
      events.push({
        type: 'sent',
        via,
        endpoint: via === 'jito' ? jito!.label : 'rpc-pool',
        attempt: 1,
      });

      const rebroadcastAbort = new AbortController();
      const onUpstreamAbort = (): void => rebroadcastAbort.abort();
      signal.addEventListener('abort', onUpstreamAbort, { once: true });
      stopRebroadcast = () => {
        signal.removeEventListener('abort', onUpstreamAbort);
        rebroadcastAbort.abort();
      };
      void startRebroadcast({
        // Alternate routes so a black-holing Jito region can't absorb every resend.
        send: async attempt => {
          const via = await sendOnce(useJito && attempt % 2 === 1);
          events.push({ type: 'resent', via, attempt });
        },
        ...(input.rebroadcastIntervalMs !== undefined
          ? { intervalMs: input.rebroadcastIntervalMs }
          : {}),
        signal: rebroadcastAbort.signal,
      });
    } else {
      // Wallet-style sending signer: the wallet signs AND sends. We don't own
      // the wire bytes, so there is no Jito routing and no rebroadcast — but we
      // still own confirmation, expiry tracking, and status events.
      assertIsTransactionMessageWithSingleSendingSigner(message);
      const signatureBytes = await signAndSendTransactionMessageWithSigners(message, {
        abortSignal: signal,
      });
      txSignature = getBase58Decoder().decode(signatureBytes) as Signature;
      signatureForFailure = txSignature;
      events.push({ type: 'signed', signature: txSignature });
      sink.onSigned(txSignature);
      events.push({ type: 'sent', via: 'rpc', endpoint: 'wallet', attempt: 1 });
    }

    let confirmation: ConfirmationResult;
    try {
      confirmation = await confirmSignature({
        rpc: context.rpc,
        ...(context.subscriptions ? { subscriptions: context.subscriptions } : {}),
        signature: txSignature,
        commitment,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
        signal,
      });
    } finally {
      stopRebroadcast?.();
    }

    if (confirmation.type === 'expired') {
      events.push({
        type: 'expired',
        signature: txSignature,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        blockHeight: confirmation.blockHeight,
      });
      context.metrics?.count('solana_shield.tx.outcome', { outcome: 'expired' });
      throw new TxExpiredError(txSignature, latest.lastValidBlockHeight, confirmation.blockHeight);
    }
    if (confirmation.err != null) {
      context.metrics?.count('solana_shield.tx.outcome', { outcome: 'failed' });
      throw new TxFailedError(txSignature, confirmation.err);
    }

    const confirmedEvent: TxConfirmedEvent = {
      type: 'confirmed',
      signature: txSignature,
      commitment,
      slot: confirmation.slot,
      confirmedVia: confirmation.via,
    };
    events.push(confirmedEvent);
    context.metrics?.count('solana_shield.tx.outcome', { outcome: 'confirmed' });
    context.metrics?.histogram('solana_shield.tx.confirmation.duration', Date.now() - startedAt);
    sink.onConfirmed(confirmedEvent);
    events.end();
  } catch (error) {
    if (!(error instanceof TxExpiredError)) {
      events.push({
        type: 'failed',
        ...(signatureForFailure ? { signature: signatureForFailure } : {}),
        error,
      });
    }
    sink.onError(error);
    events.end();
  }
}

/** Hand-rolled SystemProgram transfer (avoids a runtime dep on @solana-program/system). */
export function transferInstruction(from: Address, to: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true); // SystemInstruction::Transfer
  view.setBigUint64(4, lamports, true);
  return {
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: to, role: AccountRole.WRITABLE },
    ],
    data,
    programAddress: SYSTEM_PROGRAM_ADDRESS,
  };
}

function collectWritableAddresses(message: {
  readonly feePayer: { readonly address: Address };
  readonly instructions: readonly Instruction[];
}): string[] {
  const writable = new Set<string>([message.feePayer.address]);
  for (const instruction of message.instructions) {
    for (const account of instruction.accounts ?? []) {
      if (isWritableRole(account.role)) writable.add(account.address);
    }
  }
  return [...writable];
}
