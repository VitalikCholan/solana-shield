import { createSolanaRpcFromTransport, generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FeeSource } from '../../../src/fees/types.js';
import { TxSimulationError, decodeSimulationError } from '../../../src/tx/errors.js';
import { sendReliably, transferInstruction } from '../../../src/tx/pipeline.js';
import { createMockTransport } from '../../helpers/mock-transport.js';
import type { MockTransport } from '../../helpers/mock-transport.js';

const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(8));
const stubFee: FeeSource = { name: 'stub', estimate: async () => 1n };

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

function harness(simErr: unknown, logs: string[] = []): {
  transport: MockTransport;
  rpc: ReturnType<typeof createSolanaRpcFromTransport>;
} {
  const transport = createMockTransport({
    getLatestBlockhash: {
      context: { slot: 1n },
      value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
    },
    simulateTransaction: {
      context: { slot: 1n },
      value: { err: simErr, logs, unitsConsumed: 5000n, accounts: null, returnData: null },
    },
    sendTransaction: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
    getSignatureStatuses: {
      context: { slot: 100n },
      value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
    },
    getBlockHeight: 50n,
  });
  return { transport, rpc: createSolanaRpcFromTransport(transport) };
}

describe('preflight simulation', () => {
  it('rejects before broadcast with a decoded reason when simulation reveals an error', async () => {
    const { transport, rpc } = harness({ InstructionError: [0, { Custom: 6000 }] }, [
      'Program log: AnchorError occurred. Error Message: Slippage tolerance exceeded.',
    ]);
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      { instructions: [transferInstruction(signer.address, signer.address, 1n)], signer, pollIntervalMs: 1 },
    );
    const err = await handle.result.catch(e => e);
    expect(err).toBeInstanceOf(TxSimulationError);
    expect((err as TxSimulationError).message).toMatch(/custom program error 6000/);
    expect((err as TxSimulationError).message).toMatch(/Slippage tolerance exceeded/);
    // Caught cheaply — never broadcast.
    expect(transport.callsFor('sendTransaction')).toHaveLength(0);
  });

  it('broadcasts anyway when preflight is disabled', async () => {
    const { transport, rpc } = harness({ InstructionError: [0, 'InvalidArgument'] });
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        preflight: false,
        pollIntervalMs: 1,
      },
    );
    await handle.result; // the mock confirms it
    expect(transport.callsFor('sendTransaction').length).toBeGreaterThan(0);
  });

  it('proceeds when simulation passes', async () => {
    const { transport, rpc } = harness(null);
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      { instructions: [transferInstruction(signer.address, signer.address, 1n)], signer, pollIntervalMs: 1 },
    );
    expect((await handle.result).type).toBe('confirmed');
    expect(transport.callsFor('sendTransaction').length).toBeGreaterThan(0);
  });
});

describe('decodeSimulationError', () => {
  it('humanizes plain string errors', () => {
    expect(decodeSimulationError('AccountNotFound')).toBe('account not found');
  });

  it('decodes custom program errors and pulls the reason from anchor logs', () => {
    expect(
      decodeSimulationError({ InstructionError: [0, { Custom: 6000 }] }, [
        'Program log: Error Message: Slippage tolerance exceeded.',
      ]),
    ).toBe('instruction #0 failed: custom program error 6000 (0x1770) — Slippage tolerance exceeded');
  });

  it('decodes string instruction errors', () => {
    expect(decodeSimulationError({ InstructionError: [1, 'InvalidArgument'] })).toBe(
      'instruction #1 failed: invalid argument',
    );
  });

  it('humanizes other single-key transaction errors', () => {
    expect(decodeSimulationError({ InsufficientFundsForRent: { account_index: 0 } })).toBe(
      'insufficient funds for rent',
    );
  });
});
