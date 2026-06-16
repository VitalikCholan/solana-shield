import {
  address,
  createSolanaRpcFromTransport,
  generateKeyPairSigner,
  getBase58Decoder,
} from '@solana/kit';
import type { Nonce } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import type { FeeSource } from '../../../src/fees/types.js';
import type { TxStatusEvent } from '../../../src/tx/events.js';
import { fetchNonceValue } from '../../../src/tx/nonce.js';
import { sendReliably, transferInstruction } from '../../../src/tx/pipeline.js';
import { createMockTransport } from '../../helpers/mock-transport.js';
import type { MockTransport } from '../../helpers/mock-transport.js';

const NONCE = getBase58Decoder().decode(new Uint8Array(32).fill(5)) as Nonce;
const NONCE_ACCOUNT = address('SysvarC1ock11111111111111111111111111111111');
const stubFee: FeeSource = { name: 'stub', estimate: async () => 100n };

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

/** Node handlers for durable-nonce mode. `getBlockHeight` is enormous on
 *  purpose — a blockhash tx would be long expired; a durable nonce must ignore it. */
function harness(
  opts: { confirmAfterPolls?: number; nonceAccountData?: string; blockHeight?: bigint } = {},
): {
  transport: MockTransport;
  rpc: ReturnType<typeof createSolanaRpcFromTransport>;
} {
  const confirmAfter = opts.confirmAfterPolls ?? 0;
  let sendCount = 0;
  const transport = createMockTransport({
    getAccountInfo: {
      context: { slot: 1n },
      value: opts.nonceAccountData
        ? { data: [opts.nonceAccountData, 'base64'], lamports: 1n, owner: '11111111111111111111111111111111', executable: false, rentEpoch: 0n }
        : null,
    },
    getLatestBlockhash: {
      context: { slot: 1n },
      value: { blockhash: getBase58Decoder().decode(new Uint8Array(32).fill(9)), lastValidBlockHeight: 1000n },
    },
    simulateTransaction: {
      context: { slot: 1n },
      value: { err: null, logs: [], unitsConsumed: 20_000n, accounts: null, returnData: null },
    },
    sendTransaction: () => `sig-${sendCount++}`,
    getSignatureStatuses: (params: unknown, i: number) => {
      const sigs = (params as unknown[])[0] as string[];
      const confirmed = i >= confirmAfter;
      return {
        context: { slot: 100n },
        value: sigs.map((_s, idx) =>
          confirmed && idx === sigs.length - 1
            ? { slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }
            : null,
        ),
      };
    },
    getBlockHeight: opts.blockHeight ?? 10_000_000n, // huge by default: proves durable nonce ignores expiry
  });
  return { transport, rpc: createSolanaRpcFromTransport(transport) };
}

async function collect(handle: AsyncIterable<TxStatusEvent>): Promise<TxStatusEvent[]> {
  const out: TxStatusEvent[] = [];
  for await (const e of handle) out.push(e);
  return out;
}

describe('fetchNonceValue', () => {
  it('parses the nonce at offset 40..72 of the account', async () => {
    const data = new Uint8Array(80);
    const nonceBytes = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 3) & 0xff);
    data.set(nonceBytes, 40);
    const b64 = Buffer.from(data).toString('base64');
    const { rpc } = harness({ nonceAccountData: b64 });
    expect(await fetchNonceValue(rpc, NONCE_ACCOUNT)).toBe(getBase58Decoder().decode(nonceBytes));
  });

  it('throws when the account is missing', async () => {
    const { rpc } = harness();
    await expect(fetchNonceValue(rpc, NONCE_ACCOUNT)).rejects.toThrow(/not found/);
  });

  it('throws on an account too small to be a nonce account', async () => {
    const { rpc } = harness({ nonceAccountData: Buffer.from(new Uint8Array(20)).toString('base64') });
    await expect(fetchNonceValue(rpc, NONCE_ACCOUNT)).rejects.toThrow(/not an initialized nonce/);
  });
});

describe('durable-nonce mode', () => {
  it('builds with a nonce lifetime (no blockhash) and confirms', async () => {
    const { transport, rpc } = harness();
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        durableNonce: { account: NONCE_ACCOUNT, nonce: NONCE },
        pollIntervalMs: 2,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
    // Durable nonce ⇒ no recent blockhash fetched, and nonce was provided so no account read.
    expect(transport.callsFor('getLatestBlockhash')).toHaveLength(0);
    expect(transport.callsFor('getAccountInfo')).toHaveLength(0);
  });

  it('never expires: confirms even though block height dwarfs any blockhash window', async () => {
    const { transport, rpc } = harness({ confirmAfterPolls: 4 });
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        durableNonce: { account: NONCE_ACCOUNT, nonce: NONCE },
        pollIntervalMs: 3,
        rebroadcastIntervalMs: 3,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
    // No expiry path ⇒ the block-height check is never consulted.
    expect(transport.callsFor('getBlockHeight')).toHaveLength(0);
  });

  it('auto-fetches the nonce value from the account when omitted', async () => {
    const data = new Uint8Array(80);
    data.set(new Uint8Array(32).fill(11), 40);
    const { transport, rpc } = harness({ nonceAccountData: Buffer.from(data).toString('base64') });
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        durableNonce: { account: NONCE_ACCOUNT },
        pollIntervalMs: 2,
      },
    );
    await handle.result;
    expect(transport.callsFor('getAccountInfo')).toHaveLength(1);
  });

  it('rejects durable-nonce mode for a sending-only wallet signer', async () => {
    const { rpc } = harness();
    const sendingSigner = {
      address: signer.address,
      signAndSendTransactions: async () => [new Uint8Array(64)],
    } as never;
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer: sendingSigner,
        durableNonce: { account: NONCE_ACCOUNT, nonce: NONCE },
      },
    );
    await expect(handle.result).rejects.toThrow(/durableNonce requires a keypair-style signer/);
  });
});

describe('fee escalation (nonce-gated)', () => {
  it('climbs the priority fee across rebroadcasts and re-signs each time', async () => {
    const { transport, rpc } = harness({ confirmAfterPolls: 5 });
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        durableNonce: { account: NONCE_ACCOUNT, nonce: NONCE },
        feeEscalation: { factor: 1.5, maxMultiplier: 5 },
        pollIntervalMs: 6,
        rebroadcastIntervalMs: 4,
      },
    );
    await handle.result;
    const events = await collect(handle);
    const resent = events.filter(e => e.type === 'resent') as Extract<TxStatusEvent, { type: 'resent' }>[];
    expect(resent.length).toBeGreaterThanOrEqual(2);
    // base 100 µlam/CU → 1.5×, 2.25× ⇒ 150, 225 (strictly climbing).
    expect(resent[0]!.microLamportsPerCu).toBe(150n);
    expect(resent[1]!.microLamportsPerCu).toBe(225n);
    expect(resent[1]!.microLamportsPerCu! > resent[0]!.microLamportsPerCu!).toBe(true);
    // Re-signing produced distinct wire bytes per rebroadcast.
    const wires = new Set(transport.callsFor('sendTransaction').map(c => (c.params as unknown[])[0]));
    expect(wires.size).toBeGreaterThanOrEqual(2);
  });

  it('is ignored without a durable nonce (blockhash mode rebroadcasts identical bytes)', async () => {
    // Normal block height (< lastValidBlockHeight 1000) so the blockhash tx
    // doesn't expire before confirming.
    const { transport, rpc } = harness({ confirmAfterPolls: 3, blockHeight: 50n });
    const handle = sendReliably(
      { rpc, feeSource: stubFee },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        feeEscalation: { factor: 2 }, // no durableNonce ⇒ must be a no-op
        pollIntervalMs: 4,
        rebroadcastIntervalMs: 3,
      },
    );
    await handle.result;
    // Identical bytes resent ⇒ a single distinct wire.
    const wires = new Set(transport.callsFor('sendTransaction').map(c => (c.params as unknown[])[0]));
    expect(wires.size).toBe(1);
  });
});
