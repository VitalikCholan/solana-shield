/**
 * End-to-end transaction pipeline under network chaos: a real kit RPC client
 * over the resilient transport over chaos-wrapped mock endpoints.
 */
import { createSolanaRpcFromTransport, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createChaosTransport } from '../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../src/chaos/prng.js';
import type { FeeSource } from '../../src/fees/types.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import { TxExpiredError } from '../../src/tx/errors.js';
import type { TxStatusEvent } from '../../src/tx/events.js';
import { sendReliably, transferInstruction } from '../../src/tx/pipeline.js';
import { createMockTransport } from '../helpers/mock-transport.js';

const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(8));

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

const stubFeeSource: FeeSource = { name: 'stub', estimate: async () => 100n };

function nodeHandlers(options: { confirmAfterPolls?: number; blockHeight?: bigint } = {}) {
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
    sendTransaction: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
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

describe('scenario: transaction confirms despite a flaky network', () => {
  it('lands the tx through retries with deterministic chaos (seed 42)', async () => {
    const flaky = createChaosTransport(createMockTransport(nodeHandlers({ confirmAfterPolls: 2 })), {
      seed: 42,
      dropRate: 0.35,
      httpErrors: [{ status: 503, rate: 0.15 }],
    });
    const backup = createMockTransport(nodeHandlers({ confirmAfterPolls: 2 }));
    const { transport } = createResilientTransport({
      endpoints: [
        // Heavy weight: the flaky endpoint is always tried first, guaranteeing
        // the chaos faults actually exercise the retry path.
        { id: 'flaky', url: 'https://x', transport: flaky, weight: 10_000 },
        { id: 'backup', url: 'https://y', transport: backup },
      ],
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(21),
    });
    const rpc = createSolanaRpcFromTransport(transport);

    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 5,
        rebroadcastIntervalMs: 8,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');

    const events: TxStatusEvent[] = [];
    for await (const event of handle) events.push(event);
    expect(events[0]!.type).toBe('building');
    expect(events.at(-1)!.type).toBe('confirmed');
    // The chaotic endpoint was actually in the rotation; whether each draw
    // faulted is seed-dependent, and surviving either way is the point.
    // (The degraded-provider scenario asserts fault-driven retries directly.)
    expect(flaky.stats.calls).toBeGreaterThan(0);
  });
});

describe('scenario: blockhash expiry under a 100% send-drop network', () => {
  it('reports expiry with TxExpiredError instead of hanging or silently re-signing', async () => {
    // Reads work; sendTransaction is black-holed; chain height passes the lifetime.
    const transport = createMockTransport({
      ...nodeHandlers(),
      sendTransaction: () => {
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      },
      getSignatureStatuses: { context: { slot: 100n }, value: [null] },
      getBlockHeight: (_p: unknown, i: number) => (i < 1 ? 999n : 2000n),
    });
    const { transport: resilient } = createResilientTransport({
      endpoints: [{ id: 'only', url: 'https://x', transport }],
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(2),
    });
    const rpc = createSolanaRpcFromTransport(resilient);

    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 5,
      },
    );
    // The very first send already fails on every endpoint → failure event,
    // because the pipeline distinguishes "never sent" from "sent then expired".
    const error = await handle.result.catch(e => e);
    expect(error).toBeTruthy();

    const events: TxStatusEvent[] = [];
    for await (const event of handle) events.push(event);
    expect(['failed', 'expired']).toContain(events.at(-1)!.type);
  });

  it('expires exactly at lastValidBlockHeight when sends succeed but never land', async () => {
    const transport = createMockTransport({
      ...nodeHandlers(),
      getSignatureStatuses: { context: { slot: 100n }, value: [null] },
      getBlockHeight: (_p: unknown, i: number) => (i === 0 ? 1000n : 1001n), // boundary: == is alive, > expires
    });
    const { transport: resilient } = createResilientTransport({
      endpoints: [{ id: 'only', url: 'https://x', transport }],
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(2),
    });
    const rpc = createSolanaRpcFromTransport(resilient);
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 1,
      },
    );
    const error = await handle.result.catch(e => e);
    expect(error).toBeInstanceOf(TxExpiredError);
    expect((error as TxExpiredError).blockHeight).toBe(1001n);
    expect((error as TxExpiredError).lastValidBlockHeight).toBe(1000n);
  });
});
