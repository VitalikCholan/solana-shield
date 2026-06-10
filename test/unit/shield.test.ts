import type { RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/kit';
import { generateKeyPairSigner, getBase58Decoder } from '@solana/kit';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createShield } from '../../src/index.js';
import type { Shield } from '../../src/index.js';
import { transferInstruction } from '../../src/tx/pipeline.js';
import { createMockTransport, okResponse } from '../helpers/mock-transport.js';

const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(4));

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

const happyHandlers = () => ({
  getSlot: 1234n,
  getLatestBlockhash: {
    context: { slot: 1n },
    value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n },
  },
  simulateTransaction: {
    context: { slot: 1n },
    value: { err: null, logs: [], unitsConsumed: 10_000n, accounts: null, returnData: null },
  },
  sendTransaction: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
  getSignatureStatuses: {
    context: { slot: 100n },
    value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  },
  getBlockHeight: 500n,
  getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 42n }],
});

function fakeSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
  return {
    signatureNotifications: () => ({
      subscribe: async () =>
        (async function* () {
          // never yields — polling wins in these tests
          await new Promise(() => {});
        })(),
    }),
  } as unknown as RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
});

describe('createShield', () => {
  it('serves typed RPC calls through the resilient transport with failover', async () => {
    const failing = createMockTransport({
      getSlot: () => {
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      },
    });
    const healthy = createMockTransport({ getSlot: 777n });
    const transports = [failing, healthy];
    shield = createShield(
      {
        endpoints: [
          // Heavy weight makes 'a' the first pick despite random P2C sampling.
          { url: 'https://a.example.com', label: 'a', weight: 10_000 },
          { url: 'https://b.example.com', label: 'b', weight: 1 },
        ],
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
        slotProbe: { enabled: false },
      },
      {
        transportFactory: () => transports.shift()!,
        subscriptionsFactory: fakeSubscriptions,
      },
    );
    expect(await shield.rpc.getSlot().send()).toBe(777n);
    expect(shield.health.get('a')!.totalFailures).toBeGreaterThanOrEqual(1);
    expect(shield.endpoints.map(e => e.label)).toEqual(['a', 'b']);
  });

  it('sends a transaction end-to-end through sendReliably', async () => {
    const transport = createMockTransport(happyHandlers());
    shield = createShield(
      {
        endpoints: ['devnet'],
        slotProbe: { enabled: false },
      },
      { transportFactory: () => transport, subscriptionsFactory: fakeSubscriptions },
    );
    const handle = shield.sendReliably({
      instructions: [transferInstruction(signer.address, signer.address, 1n)],
      signer,
      pollIntervalMs: 1,
    });
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
    // Fee oracle used the native source through the resilient rpc.
    expect(transport.callsFor('getRecentPrioritizationFees').length).toBeGreaterThan(0);
  });

  it('builds provider-matched fee sources from endpoint URLs', async () => {
    const helius = createMockTransport({
      ...happyHandlers(),
      getPriorityFeeEstimate: { result: { priorityFeeEstimate: 5000 } },
    });
    shield = createShield(
      {
        endpoints: [{ url: 'https://mainnet.helius-rpc.com/?api-key=x', label: 'helius' }],
        slotProbe: { enabled: false },
      },
      { transportFactory: () => helius, subscriptionsFactory: fakeSubscriptions },
    );
    expect(shield.fees.name).toBe('oracle(helius+native)');
    const fee = await shield.fees.estimate({ writableAddresses: ['x'], level: 'medium' }, {});
    expect(fee).toBe(5000n); // max(helius 5000, native 42)
  });

  it('exposes a Jito sender only when configured', () => {
    const transport = createMockTransport({ getSlot: 1n });
    shield = createShield(
      { endpoints: ['devnet'], slotProbe: { enabled: false } },
      { transportFactory: () => transport, subscriptionsFactory: fakeSubscriptions },
    );
    expect(shield.jito).toBeUndefined();
    shield.destroy();
    shield = createShield(
      { endpoints: ['devnet'], jito: { regions: ['frankfurt'] }, slotProbe: { enabled: false } },
      { transportFactory: () => transport, subscriptionsFactory: fakeSubscriptions },
    );
    expect(shield.jito?.label).toBe('jito:frankfurt');
  });

  it('feeds the health registry from the slot probe', async () => {
    const transport = createMockTransport({ getSlot: () => okResponse(4321n, 'shield-slot-probe') });
    shield = createShield(
      { endpoints: ['devnet'], slotProbe: { intervalMs: 60_000 } },
      { transportFactory: () => transport, subscriptionsFactory: fakeSubscriptions },
    );
    // The probe fires once immediately on start.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(transport.callsFor('getSlot').length).toBeGreaterThan(0);
    expect(shield.health.all()[0]!.slotLag).toBe(0);
  });
});
