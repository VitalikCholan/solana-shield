/**
 * Side-by-side proof: under the SAME injected fault, vanilla @solana/kit fails
 * where solana-shield survives. This is the clearest demonstration of the 25%
 * resilience criterion — controlled before/after on identical chaos.
 */
import { createSolanaRpcFromTransport, generateKeyPairSigner } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { createChaosTransport } from '../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../src/chaos/prng.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import { sendReliably, transferInstruction } from '../../src/tx/pipeline.js';
import { alwaysOk, createMockTransport } from '../helpers/mock-transport.js';
import { nodeHandlers, stubFeeSource } from './_fixtures.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});

describe('read path: transient endpoint failure', () => {
  it('vanilla kit (single transport, no retry) throws; shield retries and succeeds', async () => {
    // Vanilla: one endpoint that is currently failing → no recovery.
    const vanillaChaos = createChaosTransport(alwaysOk(1n), { seed: 1, dropRate: 1 });
    const vanillaRpc = createSolanaRpcFromTransport(vanillaChaos);
    await expect(vanillaRpc.getSlot().send()).rejects.toThrow();

    // Shield: the same failing endpoint, plus a healthy backup and retry policy.
    const shieldChaos = createChaosTransport(alwaysOk(1n), { seed: 1, dropRate: 1 });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'down', url: 'https://x', transport: shieldChaos, weight: 100 },
        { id: 'up', url: 'https://y', transport: createMockTransport({ getSlot: 5n }) },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(1),
    });
    await expect(transport({ payload: PAYLOAD })).resolves.toBeDefined();
  });
});

describe('write path: dropped transaction', () => {
  it('a naive one-shot send reports unconfirmed; shield rebroadcasts until it lands', async () => {
    // The node: tx does not appear until the 3rd status poll (i.e. it was "dropped"
    // on first broadcast and only lands after persistence).
    const makeNode = () => createMockTransport(nodeHandlers({ confirmAfterPolls: 3 }));

    // Naive sender: broadcast once, check status once. This is what
    // sendAndConfirm with maxRetries:0 + a single status check amounts to.
    const naiveNode = makeNode();
    const naiveRpc = createSolanaRpcFromTransport(
      createResilientTransport({
        endpoints: [{ id: 'n', url: 'https://n', transport: naiveNode }],
        retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 1 },
      }).transport,
    );
    const sig = await naiveRpc
      .sendTransaction('AA==' as never, { encoding: 'base64', skipPreflight: true })
      .send()
      .catch(() => undefined);
    const naiveStatus = (await naiveRpc.getSignatureStatuses([
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as never,
    ]).send()).value[0];
    expect(sig).toBeDefined();
    expect(naiveStatus).toBeNull(); // naive gives up here: still unconfirmed

    // Shield: same node, same drop — rebroadcast + polling carry it to confirmation.
    const shieldNode = makeNode();
    const { transport } = createResilientTransport({
      endpoints: [{ id: 's', url: 'https://s', transport: shieldNode }],
      retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
    });
    const handle = sendReliably(
      { rpc: createSolanaRpcFromTransport(transport), feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 3,
        rebroadcastIntervalMs: 4,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
  });
});
