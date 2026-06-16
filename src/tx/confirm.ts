import type {
  Commitment,
  GetBlockHeightApi,
  GetSignatureStatusesApi,
  Rpc,
  Signature,
} from '@solana/kit';
import { sleep } from '../internal/async.js';

/**
 * Minimal structural view of kit's `RpcSubscriptions<SignatureNotificationsApi>` —
 * keeps confirm testable with fakes while accepting the real client.
 */
export interface SignatureSubscriptionsClient {
  signatureNotifications(
    signature: Signature,
    config?: Readonly<{ commitment?: Commitment }>,
  ): {
    subscribe(opts: Readonly<{ abortSignal: AbortSignal }>): Promise<
      AsyncIterable<{
        readonly context: { readonly slot: bigint };
        readonly value: { readonly err: unknown } | unknown;
      }>
    >;
  };
}

export type ConfirmationResult =
  | {
      readonly type: 'confirmed';
      readonly signature: Signature;
      readonly slot: bigint;
      readonly err: unknown;
      readonly via: 'ws' | 'poll';
    }
  | { readonly type: 'expired'; readonly blockHeight: bigint };

export interface ConfirmOptions {
  readonly rpc: Rpc<GetSignatureStatusesApi & GetBlockHeightApi>;
  /** Subscription clients to try in order; all may fail — polling always backstops. */
  readonly subscriptions?: readonly SignatureSubscriptionsClient[];
  /** Primary signature (used for the WS subscription). */
  readonly signature: Signature;
  /**
   * Dynamic signature set to poll. Defaults to `[signature]`. Under fee
   * escalation each rebroadcast produces a new signature (all pinned to the
   * same durable nonce, so at most one can land) — this lets polling watch the
   * whole set and report whichever confirms.
   */
  readonly getSignatures?: () => readonly Signature[];
  readonly commitment: Commitment;
  /**
   * Blockhash expiry boundary. Omit for durable-nonce transactions, which never
   * expire — confirmation then runs until success or the caller aborts.
   */
  readonly lastValidBlockHeight?: bigint;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

function meetsCommitment(status: string | null | undefined, commitment: Commitment): boolean {
  if (!status) return false;
  if (commitment === 'processed') return true;
  if (commitment === 'confirmed') return status === 'confirmed' || status === 'finalized';
  return status === 'finalized';
}

/**
 * Dual-path confirmation: a WebSocket `signatureNotifications` subscription and a
 * `getSignatureStatuses` polling loop race each other; whichever resolves first
 * wins. Polling owns expiry detection (when a `lastValidBlockHeight` is given),
 * with a final status check after the boundary to close the "landed in the last
 * block" race. With no `lastValidBlockHeight` (durable nonce) it never expires.
 */
export async function confirmSignature(options: ConfirmOptions): Promise<ConfirmationResult> {
  const pollIntervalMs = options.pollIntervalMs ?? 2000;
  const done = new AbortController();
  const signal = options.signal ? mergeSignals(options.signal, done.signal) : done.signal;

  try {
    return await Promise.race([
      pollLoop(options, pollIntervalMs, signal),
      ...(options.subscriptions ?? []).map(client => wsWatch(client, options, signal)),
    ]);
  } finally {
    done.abort();
  }
}

async function wsWatch(
  client: SignatureSubscriptionsClient,
  options: ConfirmOptions,
  signal: AbortSignal,
): Promise<ConfirmationResult> {
  try {
    const notifications = await client
      .signatureNotifications(options.signature, { commitment: options.commitment })
      .subscribe({ abortSignal: signal });
    for await (const notification of notifications) {
      const value = (notification as { value?: { err?: unknown } }).value;
      return {
        type: 'confirmed',
        signature: options.signature,
        slot: notification.context.slot,
        err: value && typeof value === 'object' && 'err' in value ? value.err : null,
        via: 'ws',
      };
    }
  } catch {
    // WS path is best-effort; polling backstops every failure mode.
  }
  // Subscription ended without a notification (or failed): never resolve —
  // let the polling path decide. (The shared signal tears this promise down.)
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
  });
}

async function pollLoop(
  options: ConfirmOptions,
  pollIntervalMs: number,
  signal: AbortSignal,
): Promise<ConfirmationResult> {
  for (;;) {
    signal.throwIfAborted();

    const status = await checkStatus(options, signal);
    if (status) return status;

    if (options.lastValidBlockHeight !== undefined) {
      const blockHeight = await options.rpc
        .getBlockHeight({ commitment: options.commitment })
        .send({ abortSignal: signal });
      if (blockHeight > options.lastValidBlockHeight) {
        // The lifetime is over — but the tx may have landed in one of the last
        // blocks between our previous poll and now. One final authoritative check.
        const lastCheck = await checkStatus(options, signal);
        return lastCheck ?? { type: 'expired', blockHeight };
      }
    }

    await sleep(pollIntervalMs, signal);
  }
}

async function checkStatus(
  options: ConfirmOptions,
  signal: AbortSignal,
): Promise<ConfirmationResult | undefined> {
  const signatures = options.getSignatures?.() ?? [options.signature];
  const response = await options.rpc
    .getSignatureStatuses(signatures)
    .send({ abortSignal: signal });
  for (let i = 0; i < signatures.length; i++) {
    const status = response.value[i];
    if (status && meetsCommitment(status.confirmationStatus, options.commitment)) {
      return { type: 'confirmed', signature: signatures[i]!, slot: status.slot, err: status.err, via: 'poll' };
    }
  }
  return undefined;
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // AbortSignal.any is available on Node >= 20 and modern browsers.
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([a, b]);
  const controller = new AbortController();
  const forward = (signal: AbortSignal) => () => controller.abort(signal.reason);
  if (a.aborted) controller.abort(a.reason);
  else a.addEventListener('abort', forward(a), { once: true });
  if (b.aborted) controller.abort(b.reason);
  else b.addEventListener('abort', forward(b), { once: true });
  return controller.signal;
}
