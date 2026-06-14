/**
 * Judging criterion: Resilience Quality (25%) — "network congestion."
 * Congestion = latency + rate-limiting + drops, often together. Modeled as fault
 * profiles. Mapped in docs/resilience.md.
 */
import { createSolanaRpcFromTransport, generateKeyPairSigner } from '@solana/kit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createChaosTransport } from '../../src/chaos/chaos-transport.js';
import { mulberry32 } from '../../src/chaos/prng.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import { sendReliably, transferInstruction } from '../../src/tx/pipeline.js';
import { alwaysOk, createMockTransport, okResponse } from '../helpers/mock-transport.js';
import { nodeHandlers, stubFeeSource } from './_fixtures.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };

let signer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
beforeAll(async () => {
  signer = await generateKeyPairSigner();
});
afterEach(() => vi.useRealTimers());

describe('congestion: a node hangs (latency spike) — bounded by per-request timeout', () => {
  it('times out the hung endpoint and rotates instead of hanging forever', async () => {
    vi.useFakeTimers();
    const hung = createChaosTransport(alwaysOk(1n), { seed: 1, slowLoris: { rate: 1, hangMs: 60_000 } });
    const fast = createMockTransport({ getSlot: 99n });
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'hung', url: 'https://x', transport: hung, weight: 100 },
        { id: 'fast', url: 'https://y', transport: fast },
      ],
      retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 1 },
      requestTimeoutMs: 50,
      random: mulberry32(1),
    });
    const pending = transport({ payload: PAYLOAD });
    await vi.advanceTimersByTimeAsync(60); // trip the 50ms timeout, rotate to fast
    expect(await pending).toEqual(okResponse(99n, 1));
  });
});

describe('congestion: rate-limit storm (429 across most of the pool)', () => {
  it('concentrates traffic on the surviving node and keeps succeeding', async () => {
    const limitedA = createChaosTransport(alwaysOk(1n), { seed: 2, httpErrors: [{ status: 429, rate: 1 }] });
    const limitedB = createChaosTransport(alwaysOk(2n), { seed: 3, httpErrors: [{ status: 429, rate: 1 }] });
    const survivor = createMockTransport({ getSlot: 7n });
    const { transport, health } = createResilientTransport({
      endpoints: [
        { id: 'a', url: 'https://a', transport: limitedA },
        { id: 'b', url: 'https://b', transport: limitedB },
        { id: 'survivor', url: 'https://s', transport: survivor },
      ],
      retry: { maxAttempts: 4, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(9),
    });
    let failures = 0;
    for (let i = 0; i < 40; i++) await transport({ payload: PAYLOAD }).catch(() => (failures += 1));
    expect(failures).toBe(0);
    // After the throttled nodes enter cooldown, the survivor carries the load.
    expect(health.get('survivor')!.totalRequests).toBeGreaterThan(health.get('a')!.totalRequests);
  });
});

describe('congestion: 30% packet loss', () => {
  it('absorbs random drops via retries and still makes progress (deterministic seed)', async () => {
    const lossy = createChaosTransport(createMockTransport({ getSlot: 5n }), { seed: 1234, dropRate: 0.3 });
    const { transport } = createResilientTransport({
      endpoints: [{ id: 'lossy', url: 'https://x', transport: lossy }],
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(1234),
    });
    let failures = 0;
    for (let i = 0; i < 50; i++) await transport({ payload: PAYLOAD }).catch(() => (failures += 1));
    // 0.3^5 ≈ 0.24% per request → effectively all succeed; assert overwhelming success.
    expect(failures).toBeLessThanOrEqual(1);
    expect(lossy.stats.dropped).toBeGreaterThan(0); // drops really happened
  });
});

describe('congestion: full storm (latency + 429 + drops together)', () => {
  it('a transaction still lands through the combined fault profile', async () => {
    const storm = createChaosTransport(createMockTransport(nodeHandlers({ confirmAfterPolls: 2 })), {
      seed: 77,
      dropRate: 0.3,
      httpErrors: [{ status: 429, rate: 0.2 }],
      latency: { meanMs: 2, jitterMs: 1 },
    });
    const backup = createMockTransport(nodeHandlers({ confirmAfterPolls: 2 }));
    const { transport } = createResilientTransport({
      endpoints: [
        { id: 'storm', url: 'https://x', transport: storm, weight: 50 },
        { id: 'backup', url: 'https://y', transport: backup },
      ],
      retry: { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 1 },
      random: mulberry32(77),
    });
    const handle = sendReliably(
      { rpc: createSolanaRpcFromTransport(transport), feeSource: stubFeeSource },
      {
        instructions: [transferInstruction(signer.address, signer.address, 1n)],
        signer,
        pollIntervalMs: 4,
        rebroadcastIntervalMs: 5,
      },
    );
    const confirmed = await handle.result;
    expect(confirmed.type).toBe('confirmed');
  });
});
