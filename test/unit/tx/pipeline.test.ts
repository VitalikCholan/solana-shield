import type { SignatureBytes, TransactionSendingSigner } from '@solana/kit';
import {
  createSolanaRpcFromTransport,
  generateKeyPairSigner,
  getBase58Decoder,
} from '@solana/kit';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { FeeSource } from '../../../src/fees/types.js';
import type { JitoSenderLike } from '../../../src/jito/types.js';
import { TxExpiredError, TxFailedError } from '../../../src/tx/errors.js';
import type { TxStatusEvent } from '../../../src/tx/events.js';
import { sendReliably, transferInstruction } from '../../../src/tx/pipeline.js';
import type { MockTransport } from '../../helpers/mock-transport.js';
import { createMockTransport } from '../../helpers/mock-transport.js';

const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(9));
const TIP_ACCOUNT = 'SysvarC1ock11111111111111111111111111111111';

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

const stubFeeSource: FeeSource = {
  name: 'stub',
  estimate: async () => 123n,
};

interface HarnessOptions {
  readonly statuses?: (callIndex: number) => unknown;
  readonly blockHeight?: bigint;
  readonly sendError?: () => Error;
  readonly extraHandlers?: Record<string, unknown>;
}

function makeHarness(options: HarnessOptions = {}): { transport: MockTransport; rpc: ReturnType<typeof createSolanaRpcFromTransport> } {
  const statuses =
    options.statuses ??
    (() => ({
      context: { slot: 100n },
      value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    }));
  const transport = createMockTransport({
    getLatestBlockhash: {
      context: { slot: 1n },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
    },
    simulateTransaction: {
      context: { slot: 1n },
      value: {
        err: null,
        logs: [],
        unitsConsumed: 50_000n,
        accounts: null,
        returnData: null,
      },
    },
    sendTransaction: (_params: unknown, _i: number) => {
      if (options.sendError) throw options.sendError();
      return '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
    },
    getSignatureStatuses: (_params: unknown, i: number) => statuses(i),
    getBlockHeight: options.blockHeight ?? 500n,
    ...options.extraHandlers,
  });
  const rpc = createSolanaRpcFromTransport(transport);
  return { transport, rpc };
}

function makeJito(overrides: Partial<JitoSenderLike> = {}): JitoSenderLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    label: 'jito:test',
    sendTransaction: async (wire: string) => {
      sent.push(wire);
    },
    recommendedTipLamports: async () => 2000n,
    randomTipAccount: async () => TIP_ACCOUNT,
    sent,
    ...overrides,
  };
}

async function collectEvents(handle: AsyncIterable<TxStatusEvent>): Promise<TxStatusEvent[]> {
  const events: TxStatusEvent[] = [];
  for await (const event of handle) events.push(event);
  return events;
}

describe('sendReliably (keypair signer)', () => {
  it('runs the full happy path with the expected event order', async () => {
    const { rpc, transport } = makeHarness();
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 1,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
    expect(confirmed.confirmedVia).toBe('poll');
    expect(await handle.signature).toBe(confirmed.signature);

    const events = await collectEvents(handle);
    expect(events.map(e => e.type)).toEqual([
      'building',
      'feeEstimated',
      'signed',
      'sent',
      'confirmed',
    ]);
    const fee = events[1] as Extract<TxStatusEvent, { type: 'feeEstimated' }>;
    expect(fee.microLamportsPerCu).toBe(123n);
    // ~50k simulated × 1.1 buffer (kit's estimator adds a tiny fixed margin of its own)
    expect(fee.computeUnitLimit).toBeGreaterThanOrEqual(55_000);
    expect(fee.computeUnitLimit).toBeLessThan(56_000);
    expect(fee.source).toBe('stub');

    const sent = events[3] as Extract<TxStatusEvent, { type: 'sent' }>;
    expect(sent.via).toBe('rpc');
    // skipPreflight + zero node retries: the pipeline owns rebroadcast cadence.
    const sendCall = transport.callsFor('sendTransaction')[0]!;
    const sendConfig = (sendCall.params as unknown[])[1] as Record<string, unknown>;
    expect(sendConfig['skipPreflight']).toBe(true);
    expect(Number(sendConfig['maxRetries'])).toBe(0);
  });

  it('routes through Jito with a tip when configured', async () => {
    const { rpc, transport } = makeHarness();
    const jito = makeJito();
    const tipSpy = vi.spyOn(jito, 'recommendedTipLamports');
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource, jito },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        route: 'jito',
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    expect(jito.sent).toHaveLength(1);
    expect(tipSpy).toHaveBeenCalled();
    expect(transport.callsFor('sendTransaction')).toHaveLength(0);
    const events = await collectEvents(handle);
    const sent = events.find(e => e.type === 'sent') as Extract<TxStatusEvent, { type: 'sent' }>;
    expect(sent.via).toBe('jito');
    expect(sent.endpoint).toBe('jito:test');
  });

  it('falls back to RPC when the Jito send fails, with an explanatory event', async () => {
    const { rpc, transport } = makeHarness();
    const jito = makeJito({
      sendTransaction: async () => {
        throw new Error('jito 429');
      },
    });
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource, jito },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        route: 'auto',
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    expect(transport.callsFor('sendTransaction')).toHaveLength(1);
    const events = await collectEvents(handle);
    const fallback = events.find(e => e.type === 'jitoFallback') as Extract<
      TxStatusEvent,
      { type: 'jitoFallback' }
    >;
    expect(fallback.reason).toBe('jitoSendFailed');
    expect(fallback.detail).toMatch(/jito 429/);
    const sent = events.find(e => e.type === 'sent') as Extract<TxStatusEvent, { type: 'sent' }>;
    expect(sent.via).toBe('rpc');
  });

  it('uses an explicit jito tip override without consulting the tip floor', async () => {
    const { rpc } = makeHarness();
    const jito = makeJito();
    const tipSpy = vi.spyOn(jito, 'recommendedTipLamports');
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource, jito },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        route: 'jito',
        jitoTipLamports: 5000n,
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    expect(tipSpy).not.toHaveBeenCalled();
  });

  it("throws when route 'jito' is forced without a configured sender", async () => {
    const { rpc } = makeHarness();
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        route: 'jito',
      },
    );
    await expect(handle.result).rejects.toThrow(/no Jito sender/);
  });

  it('survives a fee-source outage with the 1 µlamport default', async () => {
    const { rpc } = makeHarness();
    const failingSource: FeeSource = {
      name: 'down',
      estimate: async () => {
        throw new Error('fee api down');
      },
    };
    const handle = sendReliably(
      { rpc, feeSource: failingSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    const events = await collectEvents(handle);
    const fee = events.find(e => e.type === 'feeEstimated') as Extract<
      TxStatusEvent,
      { type: 'feeEstimated' }
    >;
    expect(fee.microLamportsPerCu).toBe(1n);
    expect(fee.source).toBe('default');
  });

  it('clamps the fee to maxMicroLamportsPerCu', async () => {
    const { rpc } = makeHarness();
    const greedySource: FeeSource = { name: 'greedy', estimate: async () => 999_999_999n };
    const handle = sendReliably(
      { rpc, feeSource: greedySource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        maxMicroLamportsPerCu: 10_000n,
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    const events = await collectEvents(handle);
    const fee = events.find(e => e.type === 'feeEstimated') as Extract<
      TxStatusEvent,
      { type: 'feeEstimated' }
    >;
    expect(fee.microLamportsPerCu).toBe(10_000n);
  });

  it('keeps the default compute unit limit when simulation fails', async () => {
    const { rpc } = makeHarness({
      extraHandlers: {
        simulateTransaction: () => {
          throw new Error('simulation unavailable');
        },
      },
    });
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 1,
      },
    );
    await handle.result;
    const events = await collectEvents(handle);
    const fee = events.find(e => e.type === 'feeEstimated') as Extract<
      TxStatusEvent,
      { type: 'feeEstimated' }
    >;
    expect(fee.computeUnitLimit).toBe(200_000);
  });

  it('rejects with TxFailedError when the transaction fails on chain', async () => {
    const txErr = { InstructionError: [0, { Custom: 6000 }] };
    const { rpc } = makeHarness({
      statuses: () => ({
        context: { slot: 100n },
        value: [{ slot: 99n, confirmations: 1, err: txErr, confirmationStatus: 'confirmed' }],
      }),
    });
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 1,
      },
    );
    await expect(handle.result).rejects.toThrow(TxFailedError);
    const events = await collectEvents(handle);
    expect(events.at(-1)?.type).toBe('failed');
  });

  it('rejects with TxExpiredError when the blockhash lifetime ends', async () => {
    const { rpc } = makeHarness({
      statuses: () => ({ context: { slot: 100n }, value: [null] }),
      blockHeight: 2000n,
    });
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
    expect((error as TxExpiredError).lastValidBlockHeight).toBe(1000n);
    const events = await collectEvents(handle);
    expect(events.at(-1)?.type).toBe('expired');
  });

  it('rebroadcasts identical bytes while waiting for confirmation', async () => {
    let statusCalls = 0;
    const { rpc, transport } = makeHarness({
      statuses: i => {
        statusCalls = i;
        return i < 3
          ? { context: { slot: 100n }, value: [null] }
          : {
              context: { slot: 100n },
              value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
            };
      },
    });
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 20,
        rebroadcastIntervalMs: 10,
      },
    );
    await handle.result;
    const events = await collectEvents(handle);
    const resent = events.filter(e => e.type === 'resent');
    expect(resent.length).toBeGreaterThan(0);
    expect(statusCalls).toBeGreaterThanOrEqual(3);
    // First send + at least one rebroadcast, all identical bytes.
    const sends = transport.callsFor('sendTransaction');
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const wire = (sends[0]!.params as unknown[])[0];
    expect((sends[1]!.params as unknown[])[0]).toBe(wire);
  });

  it('rejects immediately when aborted before starting', async () => {
    const { rpc } = makeHarness();
    const controller = new AbortController();
    controller.abort();
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        abortSignal: controller.signal,
      },
    );
    await expect(handle.result).rejects.toThrow();
  });
});

describe('sendReliably (wallet sending signer)', () => {
  function makeSendingSigner(signatureBytes: Uint8Array): TransactionSendingSigner {
    return {
      address: signer.address,
      signAndSendTransactions: async transactions =>
        transactions.map(() => signatureBytes as SignatureBytes),
    };
  }

  it('lets the wallet send, degrades Jito explicitly, and still confirms', async () => {
    const sigBytes = new Uint8Array(64).fill(7);
    const { rpc, transport } = makeHarness();
    const jito = makeJito();
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource, jito },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer: makeSendingSigner(sigBytes),
        route: 'auto',
        pollIntervalMs: 1,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.signature).toBe(getBase58Decoder().decode(sigBytes));
    // The wallet sent it — our RPC pool must not double-send, and Jito is impossible.
    expect(transport.callsFor('sendTransaction')).toHaveLength(0);
    expect(jito.sent).toHaveLength(0);
    const events = await collectEvents(handle);
    const fallback = events.find(e => e.type === 'jitoFallback') as Extract<
      TxStatusEvent,
      { type: 'jitoFallback' }
    >;
    expect(fallback.reason).toBe('signerCannotExportBytes');
    const sent = events.find(e => e.type === 'sent') as Extract<TxStatusEvent, { type: 'sent' }>;
    expect(sent.endpoint).toBe('wallet');
  });
});
