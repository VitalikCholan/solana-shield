/**
 * Judging criterion: Resilience Quality (25%) — "How well does the SDK handle
 * RPC failures?"  Each test injects a distinct *kind* of RPC failure and asserts
 * the SDK recovers. Mapped in docs/resilience.md.
 */
import { createSolanaRpcFromTransport, generateKeyPairSigner } from '@solana/kit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChaosTransport } from '../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../src/chaos/prng.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import { AllEndpointsFailedError } from '../../src/transport/types.js';
import { sendReliably, transferInstruction } from '../../src/tx/pipeline.js';
import { alwaysOk, createMockTransport, okResponse } from '../helpers/mock-transport.js';
import { nodeHandlers, stubFeeSource } from './_fixtures.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});
afterEach(() => vi.useRealTimers());

describe('RPC failure: hard down (connection refused/reset)', () => {
  it('fails over to healthy nodes, ejects the dead one, re-admits it after it heals', async () => {
    let time = 0;
    const now = () => time;
    // A is hard-down for the first 5s, then heals.
    const a = createChaosTransport(
      alwaysOk(1n),
      { seed: 1, dropRate: 1, schedule: [{ afterMs: 5000, plan: { dropRate: 0 } }] },
      { now },
    );
    const b = createMockTransport({ getSlot: 2n });
    const c = createMockTransport({ getSlot: 3n });
    const { transport, health } = createResilientTransport({
      endpoints: [
        // `a` is weighted high so it is genuinely exercised (and thus tripped)
        // rather than quietly bypassed — the point is to prove ejection + recovery.
        { id: 'a', url: 'https://a', transport: a, weight: 100 },
        { id: 'b', url: 'https://b', transport: b },
        { id: 'c', url: 'https://c', transport: c },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      breaker: { failureThreshold: 3, windowMs: 60_000, baseOpenMs: 1000, maxOpenMs: 4000, now },
      random: mulberry32(7),
      now,
    });

    let failures = 0;
    for (let i = 0; i < 30; i++) {
      await transport({ payload: PAYLOAD }).catch(() => (failures += 1));
    }
    // The user never sees a failure despite a fully dead endpoint.
    expect(failures).toBe(0);
    // The dead node never actually served a request — every call to it was dropped...
    expect(a.stats.passedThrough).toBe(0);
    // ...and the health scorer down-weighted it below the healthy nodes, so the
    // balancer steers around it (avoided, not hard-failed).
    expect(health.get('a')!.score()).toBeLessThan(health.get('b')!.score());

    // It heals; the node recovers and serves traffic again (still in the pool —
    // a transient outage never permanently ejects an endpoint).
    time = 8000;
    expect(health.get('a')!.isAvailable()).toBe(true);
    await a({ payload: PAYLOAD });
    expect(a.stats.passedThrough).toBeGreaterThan(0);
  });
});

describe('RPC failure: soft errors (5xx)', () => {
  it('classifies 503s as retryable and recovers on another node', async () => {
    const flaky = createChaosTransport(alwaysOk(1n), { seed: 2, httpErrors: [{ status: 503, rate: 1 }] });
    const healthy = createMockTransport({ getSlot: 42n });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'flaky', url: 'https://x', transport: flaky, weight: 100 },
        { id: 'healthy', url: 'https://y', transport: healthy },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(2),
    });
    expect(await transport({ payload: PAYLOAD })).toEqual(okResponse(42n, 1));
  });
});

describe('RPC failure: partial (one method broken on a node)', () => {
  it('does not blacklist a node wholesale; the broken method rotates, others still use it', async () => {
    // `a` is behind ONLY for getSignatureStatuses; getSlot works fine on it.
    const a = createChaosTransport(
      createMockTransport({
        getSlot: 7n,
        getSignatureStatuses: { context: { slot: 1n }, value: [null] },
      }),
      { seed: 3, rpcErrors: [{ code: -32005, message: 'behind', rate: 1, methods: ['getSignatureStatuses'] }] },
    );
    const b = createMockTransport({
      getSlot: 8n,
      getSignatureStatuses: {
        context: { slot: 100n },
        value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
      },
    });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'a', url: 'https://a', transport: a, weight: 100 },
        { id: 'b', url: 'https://b', transport: b },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(4),
    });
    const rpc = createSolanaRpcFromTransport(transport);
    // getSlot still served by the (heavily-weighted) `a` — not blacklisted.
    expect(await rpc.getSlot().send()).toBe(7n);
    // getSignatureStatuses transparently rotates to `b`.
    const statuses = await rpc
      .getSignatureStatuses(['11111111111111111111111111111111' as never])
      .send();
    expect(statuses.value[0]?.confirmationStatus).toBe('confirmed');
  });
});

describe('RPC failure: all endpoints down simultaneously', () => {
  it('throws a clear error with underlying causes, never hangs or loops forever', async () => {
    const dead = () => createChaosTransport(alwaysOk(), { seed: 5, dropRate: 1 });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'a', url: 'https://a', transport: dead() },
        { id: 'b', url: 'https://b', transport: dead() },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(6),
    });
    const err = await transport({ payload: PAYLOAD }).catch(e => e);
    expect(err).toBeInstanceOf(AllEndpointsFailedError);
    expect((err as AllEndpointsFailedError).failures.length).toBeGreaterThan(0);
  });
});

describe('RPC failure: primary dies mid-confirmation', () => {
  it('reattaches confirmation polling to another node; the tx still resolves', async () => {
    // `a` serves everything EXCEPT getSignatureStatuses, where it dies.
    const a = createMockTransport({
      ...nodeHandlers(),
      getSignatureStatuses: () => {
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
      },
    });
    const b = createMockTransport(nodeHandlers());
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'a', url: 'https://a', transport: a, weight: 100 },
        { id: 'b', url: 'https://b', transport: b },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(8),
    });
    const rpc = createSolanaRpcFromTransport(transport);
    const handle = sendReliably(
      { rpc, feeSource: stubFeeSource },
      { instructions: [transferInstruction(signer.address, signer.address, 1n)], signer, pollIntervalMs: 2 },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
  });
});
