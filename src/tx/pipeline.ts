import type {
  Address,
  Commitment,
  GetAccountInfoApi,
  GetBlockHeightApi,
  GetLatestBlockhashApi,
  GetSignatureStatusesApi,
  Instruction,
  Nonce,
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
  setTransactionMessageLifetimeUsingDurableNonce,
  signAndSendTransactionMessageWithSigners,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import type { FeeLevel, FeeSource } from '../fees/types.js';
import type { JitoSenderLike } from '../jito/types.js';
import type { MetricsRegistry } from '../telemetry/registry.js';
import type { ConfirmationResult, SignatureSubscriptionsClient } from './confirm.js';
import { confirmSignature } from './confirm.js';
import { fetchNonceValue } from './nonce.js';
import { TxExpiredError, TxFailedError, TxSimulationError } from './errors.js';
import type { TxConfirmedEvent, TxStatusEvent } from './events.js';
import { EventStream } from './events.js';
import { startRebroadcast } from './rebroadcast.js';

const SYSTEM_PROGRAM_ADDRESS = address('11111111111111111111111111111111');
const MAX_COMPUTE_UNITS = 1_400_000;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;

export type PipelineRpc = Rpc<
  GetAccountInfoApi &
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
  /**
   * Routing policy:
   * - 'auto' (default): Jito first when configured, automatic RPC fallback;
   * - 'jito': Jito only — failures surface instead of silently falling back;
   * - 'rpc': never touch Jito.
   */
  readonly route?: 'auto' | 'jito' | 'rpc';
  readonly feeLevel?: FeeLevel;
  /** Hard ceiling so a misbehaving fee source can never drain the payer. */
  readonly maxMicroLamportsPerCu?: bigint;
  /** Multiplier applied to the simulated compute unit estimate (default 1.1). */
  readonly computeUnitBuffer?: number;
  /**
   * Preflight: simulate before broadcasting and reject early with a decoded,
   * human-readable reason if the tx would fail (default `true`). Catches doomed
   * transactions cheaply — one simulate call instead of a wasted broadcast.
   * Applies only when shield owns the signed bytes (not wallet sign-and-send).
   */
  readonly preflight?: boolean;
  /** Explicit Jito tip; defaults to the live recommended tip. */
  readonly jitoTipLamports?: bigint;
  /**
   * Durable-nonce mode: pin the transaction's lifetime to a nonce account
   * instead of a recent blockhash, so it **never expires** — it stays landable
   * until the nonce advances, surviving arbitrary congestion. Requires a
   * keypair-style signer that can export signed bytes; that signer must be the
   * nonce authority. `nonce` is auto-fetched from the account when omitted.
   */
  readonly durableNonce?: {
    readonly account: Address;
    readonly nonce?: Nonce;
  };
  /**
   * Bump the priority fee on each rebroadcast along a multiplier curve. Only
   * honored in `durableNonce` mode, where it is **safe**: every attempt shares
   * the nonce, so the first to land advances it and invalidates the rest — at
   * most one executes. (Escalating a blockhash-lifetime tx would risk
   * double-execution, so it is intentionally disabled there.)
   */
  readonly feeEscalation?: {
    /** Multiplier applied per rebroadcast (default 1.5 → 1.5×, 2.25×, …). */
    readonly factor?: number;
    /** Cap relative to the base estimate (default 5×). */
    readonly maxMultiplier?: number;
  };
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

    const durableNonce = input.durableNonce;
    const ownsBytes =
      isTransactionModifyingSigner(input.signer) || isTransactionPartialSigner(input.signer);

    if (durableNonce && !ownsBytes) {
      throw new Error(
        'durableNonce requires a keypair-style signer that can export signed bytes (the nonce ' +
          'authority); sign-and-send-only wallets are not supported in durable-nonce mode.',
      );
    }

    // --- lifetime: durable nonce (never expires) or recent blockhash ---
    let lastValidBlockHeight: bigint | undefined;
    let lifetimeMessage;
    if (durableNonce) {
      const nonceValue =
        durableNonce.nonce ?? (await fetchNonceValue(context.rpc, durableNonce.account, signal));
      lifetimeMessage = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(input.signer, m),
        m =>
          setTransactionMessageLifetimeUsingDurableNonce(
            {
              nonce: nonceValue,
              nonceAccountAddress: durableNonce.account,
              nonceAuthorityAddress: input.signer.address,
            },
            m,
          ),
        m => appendTransactionMessageInstructions(input.instructions, m),
      );
    } else {
      const { value: latest } = await context.rpc
        .getLatestBlockhash({ commitment })
        .send({ abortSignal: signal });
      lastValidBlockHeight = latest.lastValidBlockHeight;
      lifetimeMessage = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(input.signer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        m => appendTransactionMessageInstructions(input.instructions, m),
      );
    }

    const jito = context.jito;
    const wantJito = route !== 'rpc' && jito !== undefined;
    const useJito = wantJito && ownsBytes;

    if (route === 'jito' && !jito) {
      throw new Error("route 'jito' requested but no Jito sender is configured");
    }
    if (wantJito && !ownsBytes) {
      if (route === 'jito') {
        throw new Error(
          "route 'jito' requires a signer that can export signed bytes; " +
            'this wallet only supports signAndSendTransaction (it submits itself). ' +
            "Use route 'auto' or a wallet exposing solana:signTransaction.",
        );
      }
      events.push({ type: 'jitoFallback', reason: 'signerCannotExportBytes' });
    }

    let message = lifetimeMessage;
    if (useJito) {
      const tipLamports =
        input.jitoTipLamports ?? (await jito.recommendedTipLamports({ signal }));
      const tipAccount = address(await jito.randomTipAccount({ signal }));
      message = appendTransactionMessageInstructions(
        [transferInstruction(input.signer.address, tipAccount, tipLamports)],
        message,
      );
    }

    // --- fees (base estimate) ---
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
      // A fee-oracle outage must never block the send; the 1 µlamport floor
      // still lands in calm conditions and the caller sees the source.
    }
    const ceiling = input.maxMicroLamportsPerCu ?? 5_000_000n;
    if (microLamportsPerCu > ceiling) microLamportsPerCu = ceiling;
    if (microLamportsPerCu < 1n) microLamportsPerCu = 1n;

    // Set the CU price BEFORE estimating, so the simulation includes the
    // SetComputeUnitPrice instruction's own cost — otherwise the estimate omits
    // it and the final tx (price + limit + payload) can exceed the limit
    // (ComputationalBudgetExceeded). The estimator injects the limit instruction
    // itself, so simulating the priced message accounts for both budget ixs.
    const pricedMessage = setTransactionMessageComputeUnitPrice(microLamportsPerCu, message);

    let computeUnitLimit = DEFAULT_COMPUTE_UNIT_LIMIT;
    try {
      const estimated = await estimateComputeUnitLimitFactory({ rpc: context.rpc })(pricedMessage, {
        abortSignal: signal,
        commitment,
      });
      const buffer = input.computeUnitBuffer ?? 1.1;
      // Buffer for jitter, plus a flat 150-CU floor of headroom (over-paying a
      // few hundred CU costs a fraction of a lamport; under-paying is a hard fail).
      computeUnitLimit = Math.min(MAX_COMPUTE_UNITS, Math.ceil(estimated * buffer) + 150);
    } catch {
      // Simulation can fail for state-dependent transactions; fall back to the
      // default limit rather than blocking the send.
    }
    const budgetedBase = setTransactionMessageComputeUnitLimit(computeUnitLimit, pricedMessage);
    events.push({
      type: 'feeEstimated',
      microLamportsPerCu,
      computeUnitLimit,
      source: feeSourceName,
    });

    // Fee escalation is only safe — and only enabled — under a durable nonce:
    // every attempt shares the nonce, so the first to land invalidates the rest.
    const escalate = Boolean(durableNonce) && input.feeEscalation !== undefined;
    const escFactor = input.feeEscalation?.factor ?? 1.5;
    const escMaxMult = input.feeEscalation?.maxMultiplier ?? 5;
    const priceFor = (mult: number): bigint => {
      const raw = BigInt(Math.ceil(Number(microLamportsPerCu) * Math.min(mult, escMaxMult)));
      return raw > ceiling ? ceiling : raw < 1n ? 1n : raw;
    };

    // --- sign + send ---
    let txSignature: Signature;
    let stopRebroadcast: (() => void) | undefined;
    let lastRoute: 'jito' | 'rpc' = 'rpc';
    let broadcastAttempts = 1;
    const sentSignatures = new Set<Signature>();

    if (ownsBytes) {
      const signFor = async (mult: number) => {
        const priced = setTransactionMessageComputeUnitPrice(priceFor(mult), budgetedBase);
        const tx = await signTransactionMessageWithSigners(priced);
        return { wire: getBase64EncodedWireTransaction(tx), sig: getSignatureFromTransaction(tx) };
      };
      type Wire = Awaited<ReturnType<typeof signFor>>['wire'];

      let current = await signFor(1);
      txSignature = current.sig;
      sentSignatures.add(current.sig);
      signatureForFailure = txSignature;
      events.push({ type: 'signed', signature: txSignature });
      sink.onSigned(txSignature);

      // Preflight: catch a doomed tx cheaply, with a decoded reason, before broadcast.
      if (input.preflight !== false) {
        try {
          const sim = await context.rpc
            .simulateTransaction(current.wire, { encoding: 'base64', sigVerify: false })
            .send({ abortSignal: signal });
          if (sim.value.err != null) {
            throw new TxSimulationError(sim.value.err, sim.value.logs ?? []);
          }
        } catch (err) {
          if (err instanceof TxSimulationError) throw err;
          // A simulation *infrastructure* failure (node down, dropped) must not
          // block the send — only a returned `err` dooms the transaction.
        }
      }

      const sendWire = async (wire: Wire, preferJito: boolean): Promise<'jito' | 'rpc'> => {
        if (preferJito && useJito) {
          try {
            await jito.sendTransaction(wire, { signal });
            return 'jito';
          } catch (err) {
            // 'jito' is a strict policy: surface the failure, never silently
            // downgrade an explicitly frontrun-protected send to public RPC.
            if (route === 'jito') throw err;
            events.push({
              type: 'jitoFallback',
              reason: 'jitoSendFailed',
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
        await context.rpc
          .sendTransaction(wire, { encoding: 'base64', maxRetries: 0n, skipPreflight: true })
          .send({ abortSignal: signal });
        return 'rpc';
      };

      lastRoute = await sendWire(current.wire, true);
      events.push({
        type: 'sent',
        via: lastRoute,
        endpoint: lastRoute === 'jito' ? jito!.label : 'rpc-pool',
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
        // Alternate routes so a black-holing Jito region can't absorb every
        // resend — except under the strict 'jito' policy, which never mixes.
        // Under fee escalation, re-sign at a higher price each tick (a new
        // signature, all pinned to the same nonce → at most one lands).
        send: async attempt => {
          let price = microLamportsPerCu;
          if (escalate) {
            const mult = Math.min(escMaxMult, escFactor ** attempt);
            current = await signFor(mult);
            sentSignatures.add(current.sig);
            price = priceFor(mult);
          }
          lastRoute = await sendWire(
            current.wire,
            useJito && (route === 'jito' || attempt % 2 === 1),
          );
          broadcastAttempts = attempt + 1;
          events.push({ type: 'resent', via: lastRoute, attempt, microLamportsPerCu: price });
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
      const walletMessage = setTransactionMessageComputeUnitPrice(priceFor(1), budgetedBase);
      assertIsTransactionMessageWithSingleSendingSigner(walletMessage);
      const signatureBytes = await signAndSendTransactionMessageWithSigners(walletMessage, {
        abortSignal: signal,
      });
      txSignature = getBase58Decoder().decode(signatureBytes) as Signature;
      sentSignatures.add(txSignature);
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
        getSignatures: () => [...sentSignatures],
        commitment,
        ...(lastValidBlockHeight !== undefined ? { lastValidBlockHeight } : {}),
        ...(input.pollIntervalMs !== undefined ? { pollIntervalMs: input.pollIntervalMs } : {}),
        signal,
      });
    } finally {
      stopRebroadcast?.();
    }

    if (confirmation.type === 'expired') {
      const lvbh = lastValidBlockHeight ?? 0n;
      events.push({
        type: 'expired',
        signature: txSignature,
        lastValidBlockHeight: lvbh,
        blockHeight: confirmation.blockHeight,
      });
      context.metrics?.count('solana_shield.tx.outcome', { outcome: 'expired' });
      throw new TxExpiredError(txSignature, lvbh, confirmation.blockHeight);
    }
    if (confirmation.err != null) {
      context.metrics?.count('solana_shield.tx.outcome', { outcome: 'failed' });
      throw new TxFailedError(confirmation.signature, confirmation.err);
    }

    const confirmedEvent: TxConfirmedEvent = {
      type: 'confirmed',
      signature: confirmation.signature,
      commitment,
      slot: confirmation.slot,
      confirmedVia: confirmation.via,
      route: lastRoute,
      attempts: broadcastAttempts,
      durationMs: Date.now() - startedAt,
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
