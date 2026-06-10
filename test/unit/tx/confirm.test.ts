import type { Signature } from '@solana/kit';
import { createSolanaRpcFromTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import type { SignatureSubscriptionsClient } from '../../../src/tx/confirm.js';
import { confirmSignature } from '../../../src/tx/confirm.js';
import { createMockTransport } from '../../helpers/mock-transport.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as Signature;

function statusValue(confirmationStatus: string | null, err: unknown = null) {
  return {
    context: { slot: 100n },
    value: [
      confirmationStatus === null
        ? null
        : { slot: 90n, confirmations: 1, err, confirmationStatus },
    ],
  };
}

function makeRpc(handlers: Record<string, unknown>) {
  return createSolanaRpcFromTransport(createMockTransport(handlers));
}

function wsClient(
  notifications: Array<{ slot: bigint; err: unknown }>,
  options: { failSubscribe?: boolean; delayMs?: number } = {},
): SignatureSubscriptionsClient {
  return {
    signatureNotifications: () => ({
      subscribe: async () => {
        if (options.failSubscribe) throw new Error('ws connect refused');
        return (async function* () {
          if (options.delayMs) await new Promise(r => setTimeout(r, options.delayMs));
          for (const n of notifications) {
            yield { context: { slot: n.slot }, value: { err: n.err } };
          }
        })();
      },
    }),
  };
}

describe('confirmSignature', () => {
  it('confirms via polling when no subscriptions are available', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: (_p: unknown, i: number) =>
        i === 0 ? statusValue(null) : statusValue('confirmed'),
      getBlockHeight: 50n,
    });
    const result = await confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ type: 'confirmed', slot: 90n, err: null, via: 'poll' });
  });

  it('treats finalized as satisfying confirmed but not vice versa', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: (_p: unknown, i: number) =>
        i === 0 ? statusValue('confirmed') : statusValue('finalized'),
      getBlockHeight: 50n,
    });
    const result = await confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'finalized',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ type: 'confirmed', via: 'poll' });
  });

  it('confirms via websocket when the subscription fires first', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: statusValue(null),
      getBlockHeight: 50n,
    });
    const result = await confirmSignature({
      rpc,
      subscriptions: [wsClient([{ slot: 91n, err: null }])],
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 60_000,
    });
    expect(result).toEqual({ type: 'confirmed', slot: 91n, err: null, via: 'ws' });
  });

  it('falls back to polling when every subscription fails', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: statusValue('confirmed'),
      getBlockHeight: 50n,
    });
    const result = await confirmSignature({
      rpc,
      subscriptions: [wsClient([], { failSubscribe: true }), wsClient([], { failSubscribe: true })],
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ type: 'confirmed', via: 'poll' });
  });

  it('reports expiry when the block height passes lastValidBlockHeight', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: statusValue(null),
      getBlockHeight: 101n,
    });
    const result = await confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ type: 'expired', blockHeight: 101n });
  });

  it('catches a transaction that landed in the final blocks of its lifetime', async () => {
    // First status check: null. Block height: expired. Final check: confirmed.
    const rpc = makeRpc({
      getSignatureStatuses: (_p: unknown, i: number) =>
        i === 0 ? statusValue(null) : statusValue('confirmed'),
      getBlockHeight: 200n,
    });
    const result = await confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ type: 'confirmed', via: 'poll' });
  });

  it('propagates on-chain errors through the status', async () => {
    const txErr = { InstructionError: [0, 'Custom'] };
    const rpc = makeRpc({
      getSignatureStatuses: statusValue('confirmed', txErr),
      getBlockHeight: 50n,
    });
    const result = await confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 1,
    });
    expect(result.type).toBe('confirmed');
    expect((result as { err: unknown }).err).toBeTruthy();
  });

  it('rejects when the caller aborts', async () => {
    const rpc = makeRpc({
      getSignatureStatuses: statusValue(null),
      getBlockHeight: 50n,
    });
    const controller = new AbortController();
    const pending = confirmSignature({
      rpc,
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 100n,
      pollIntervalMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
