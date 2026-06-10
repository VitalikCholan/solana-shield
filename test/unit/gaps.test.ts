/** Targeted tests for branches not covered by the main suites. */
import { createSolanaRpcFromTransport } from '@solana/kit';
import type { Signature } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { renderDoctorReport } from '../../src/cli/commands/doctor.js';
import type { DoctorReport } from '../../src/cli/commands/doctor.js';
import { FeeOracle } from '../../src/fees/oracle.js';
import { createHeliusFeeSource } from '../../src/fees/sources/helius.js';
import { createNativeFeeSource } from '../../src/fees/sources/native.js';
import { createQuickNodeFeeSource } from '../../src/fees/sources/quicknode.js';
import { createTritonFeeSource } from '../../src/fees/sources/triton.js';
import type { Shield } from '../../src/index.js';
import { createShield } from '../../src/index.js';
import { sleep } from '../../src/internal/async.js';
import { MetricsRegistry } from '../../src/telemetry/registry.js';
import { EndpointSelector } from '../../src/transport/balancer.js';
import { createCoalescingMiddleware } from '../../src/transport/coalesce.js';
import { HealthRegistry } from '../../src/transport/health.js';
import { createHedgingMiddleware } from '../../src/transport/hedge.js';
import { startSlotProbe } from '../../src/transport/slot-probe.js';
import { createResilientTransport } from '../../src/transport/stack.js';
import type { RpcTransport } from '../../src/transport/types.js';
import { AllEndpointsFailedError } from '../../src/transport/types.js';
import { confirmSignature } from '../../src/tx/confirm.js';
import { TxFailedError, stringifyTxError } from '../../src/tx/errors.js';
import { alwaysOk, createMockTransport, okResponse } from '../helpers/mock-transport.js';

const PAYLOAD = { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] };
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as Signature;

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { WebSocket?: unknown }).WebSocket;
});

describe('doctor gap coverage', () => {
  function makeShield(transport: RpcTransport): Shield {
    return createShield(
      { endpoints: [{ url: 'https://main.example.com', label: 'main' }], slotProbe: { enabled: false } },
      {
        transportFactory: () => transport,
        subscriptionsFactory: () => ({}) as never,
      },
    );
  }

  it('checks websocket connectivity via the global WebSocket', async () => {
    class FakeWebSocket {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        setTimeout(() => this.onopen?.(), 1);
      }
      close(): void {}
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
    const shield = makeShield(
      createMockTransport({
        getVersion: { 'solana-core': '2.0.0' },
        getSlot: 10n,
        getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 1n }],
      }),
    );
    try {
      const report = await runDoctor(shield);
      expect(report.endpoints[0]!.ws).toBe('ok');
    } finally {
      shield.destroy();
    }
  });

  it('reports failed websockets', async () => {
    class FailingWebSocket {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        setTimeout(() => this.onerror?.(), 1);
      }
      close(): void {}
    }
    (globalThis as { WebSocket?: unknown }).WebSocket = FailingWebSocket;
    const shield = makeShield(
      createMockTransport({
        getVersion: { 'solana-core': '2.0.0' },
        getSlot: 10n,
        getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 1n }],
      }),
    );
    try {
      const report = await runDoctor(shield);
      expect(report.endpoints[0]!.ws).toBe('failed');
    } finally {
      shield.destroy();
    }
  });

  it('covers the jito doctor path with a stubbed sender', async () => {
    const base = makeShield(
      createMockTransport({
        getVersion: { 'solana-core': '2.0.0' },
        getSlot: 10n,
        getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 1n }],
      }),
    );
    try {
      const withJito = {
        ...base,
        jito: {
          label: 'jito:test',
          recommendedTipLamports: async () => 5000n,
          getTipAccounts: async () => ['a', 'b'],
        },
      } as unknown as Shield;
      const report = await runDoctor(withJito, { wsCheck: false });
      expect(report.jito).toEqual({ ok: true, tipLamports: 5000n, tipAccounts: 2 });
      expect(renderDoctorReport(report, false)).toContain('tip floor 5000');

      const failing = {
        ...base,
        jito: {
          label: 'jito:test',
          recommendedTipLamports: async () => {
            throw new Error('jito down');
          },
          getTipAccounts: async () => [],
        },
      } as unknown as Shield;
      const badReport = await runDoctor(failing, { wsCheck: false });
      expect(badReport.jito).toMatchObject({ ok: false, error: 'jito down' });
      expect(badReport.healthy).toBe(false);
      expect(renderDoctorReport(badReport, false)).toContain('jito down');
    } finally {
      base.destroy();
    }
  });

  it('diagnoses rate limits, timeouts, and wrong URLs', async () => {
    const cases: Array<[Error, RegExp]> = [
      [Object.assign(new Error('x'), { context: { statusCode: 429 } }), /rate limited/i],
      [Object.assign(new Error('x'), { context: { statusCode: 404 } }), /url looks wrong/i],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), /did not answer in time/i],
      [new RangeError('weird'), /unexpected failure/i],
    ];
    for (const [error, pattern] of cases) {
      const shield = makeShield(
        createMockTransport({
          getVersion: () => {
            throw error;
          },
          getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 1n }],
        }),
      );
      try {
        const report = await runDoctor(shield, { wsCheck: false });
        expect(report.endpoints[0]!.diagnosis).toMatch(pattern);
      } finally {
        shield.destroy();
      }
    }
  });

  it('renders endpoints lacking slots as non-agreeing', () => {
    const report: DoctorReport = {
      endpoints: [
        {
          label: 'x',
          url: 'https://x',
          reachable: true,
          ws: 'skipped',
          agreesWithPool: false,
        },
      ],
      fees: [{ source: 'native', error: 'down' }],
      healthy: false,
    };
    const text = renderDoctorReport(report, false);
    expect(text).toContain('problems detected');
  });
});

describe('fee source signal/error branches', () => {
  it('passes abort signals through every provider source', async () => {
    const signal = new AbortController().signal;
    const helius = createMockTransport({ getPriorityFeeEstimate: { result: { priorityFeeEstimate: 5 } } });
    await createHeliusFeeSource(helius).estimate({ writableAddresses: [], level: 'low' }, { signal });
    const quicknode = createMockTransport({
      qn_estimatePriorityFees: { result: { per_compute_unit: { low: 1, medium: 1, high: 1, extreme: 1 } } },
    });
    await createQuickNodeFeeSource(quicknode).estimate({ writableAddresses: [], level: 'low' }, { signal });
    const triton = createMockTransport({
      getRecentPrioritizationFees: { result: [{ slot: 1, prioritizationFee: 7n }] },
    });
    expect(
      await createTritonFeeSource(triton).estimate({ writableAddresses: [], level: 'low' }, { signal }),
    ).toBe(7n);
    const native = createMockTransport({ getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 2n }] });
    await createNativeFeeSource(createSolanaRpcFromTransport(native)).estimate(
      { writableAddresses: [], level: 'low' },
      { signal },
    );
  });

  it('reports errors without messages by code', async () => {
    const helius = createMockTransport({ getPriorityFeeEstimate: { error: { code: -32000 } } });
    await expect(
      createHeliusFeeSource(helius).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/-32000/);
    const malformed = createMockTransport({ getPriorityFeeEstimate: { result: {} } });
    await expect(
      createHeliusFeeSource(malformed).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/unexpected/);
  });

  it('counts fee source errors in metrics', async () => {
    const metrics = new MetricsRegistry();
    const oracle = new FeeOracle(
      [
        { name: 'ok', estimate: async () => 5n },
        {
          name: 'down',
          estimate: async () => {
            throw new Error('x');
          },
        },
      ],
      { metrics },
    );
    await oracle.estimate({ writableAddresses: [], level: 'low' }, {});
    expect(metrics.getCounter('solana_shield.fees.source.error')).toBe(1);
  });
});

describe('hedge gap coverage', () => {
  it('falls back to the primary when the hedge fails', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const inner = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
      const index = calls++;
      if (index === 1) throw new Error('hedge endpoint down');
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 500);
        config.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
      return okResponse('primary');
    }) as RpcTransport;
    const hedged = createHedgingMiddleware({ delayMs: 100 })(inner);
    const pending = hedged({ payload: PAYLOAD });
    await vi.advanceTimersByTimeAsync(600);
    expect(await pending).toEqual(okResponse('primary'));
    expect(calls).toBe(2);
  });

  it('rejects pre-aborted calls', async () => {
    const controller = new AbortController();
    controller.abort();
    const hedged = createHedgingMiddleware()(alwaysOk());
    await expect(hedged({ payload: PAYLOAD, signal: controller.signal })).rejects.toThrow();
  });
});

describe('misc small branches', () => {
  it('sleep rejects on pre-aborted signals and string reasons', async () => {
    const pre = new AbortController();
    pre.abort('cancelled-by-string');
    await expect(sleep(10, pre.signal)).rejects.toThrow('cancelled-by-string');
    const during = new AbortController();
    const pending = sleep(1000, during.signal);
    during.abort();
    await expect(pending).rejects.toThrow();
  });

  it('stringifyTxError handles errors, strings, bigints, and circular junk', () => {
    expect(stringifyTxError(new Error('boom'))).toBe('boom');
    expect(stringifyTxError('plain')).toBe('plain');
    expect(stringifyTxError({ InstructionError: [0n, 'Custom'] })).toContain('Custom');
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(typeof stringifyTxError(circular)).toBe('string');
    expect(new TxFailedError(undefined, 'err').message).toContain('(unsigned)');
  });

  it('AllEndpointsFailedError pluralizes correctly', () => {
    const failure = {
      kind: 'network' as const,
      retryable: true,
      rotateEndpoint: true,
      markDead: false,
      message: 'm',
      cause: undefined,
    };
    expect(new AllEndpointsFailedError([failure]).message).toContain('1 attempt)');
    expect(new AllEndpointsFailedError([failure, failure]).message).toContain('2 attempts');
  });

  it('selector reuses excluded endpoints when they are the only ones available', () => {
    const metrics = new MetricsRegistry();
    const registry = new HealthRegistry(
      [
        { id: 'a', url: 'https://a', transport: alwaysOk() },
        { id: 'b', url: 'https://b', transport: alwaysOk() },
      ],
      { metrics },
    );
    const selector = new EndpointSelector(registry, () => 0.5);
    expect(selector.select(new Set(['a', 'b']))).toBeDefined();
  });

  it('coalescing surfaces non-Error rejections as errors', async () => {
    const failing = (async () => {
       
      throw 'string-failure';
    }) as RpcTransport;
    const coalesced = createCoalescingMiddleware()(failing);
    const controller = new AbortController();
    await expect(coalesced({ payload: PAYLOAD, signal: controller.signal })).rejects.toThrow('string-failure');
  });

  it('slot probe records bigint and numeric slots, skips dead endpoints, and stops', async () => {
    vi.useFakeTimers();
    const metrics = new MetricsRegistry();
    const a = createMockTransport({ getSlot: () => okResponse(100n, 'shield-slot-probe') });
    const b = createMockTransport({ getSlot: () => okResponse(90, 'shield-slot-probe') });
    const dead = createMockTransport({});
    const registry = new HealthRegistry(
      [
        { id: 'a', url: 'https://a', transport: a },
        { id: 'b', url: 'https://b', transport: b },
        { id: 'dead', url: 'https://dead', transport: dead },
      ],
      { metrics },
    );
    registry.get('dead')!.dead = true;
    const stop = startSlotProbe(registry, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.get('a')!.slotLag).toBe(0);
    expect(registry.get('b')!.slotLag).toBe(10);
    expect(dead.calls).toHaveLength(0);
    stop();
    const callsAfterStop = a.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.calls.length).toBe(callsAfterStop);
  });

  it('slot probe tolerates probe errors', async () => {
    vi.useFakeTimers();
    const metrics = new MetricsRegistry();
    const failing = createMockTransport({
      getSlot: () => {
        throw new Error('probe refused');
      },
    });
    const registry = new HealthRegistry([{ id: 'x', url: 'https://x', transport: failing }], { metrics });
    const stop = startSlotProbe(registry, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.get('x')!.slotLag).toBe(0); // unchanged, no crash
    stop();
  });

  it('confirm tolerates a websocket stream that ends without notifying', async () => {
    const rpc = createSolanaRpcFromTransport(
      createMockTransport({
        getSignatureStatuses: {
          context: { slot: 100n },
          value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
        },
        getBlockHeight: 50n,
      }),
    );
    const endingWs = {
      signatureNotifications: () => ({
        subscribe: async () => (async function* () {})(),
      }),
    };
    const result = await confirmSignature({
      rpc,
      subscriptions: [endingWs],
      signature: SIG,
      commitment: 'confirmed',
      lastValidBlockHeight: 1000n,
      pollIntervalMs: 1,
    });
    expect(result).toMatchObject({ type: 'confirmed', via: 'poll' });
  });

  it('stack accepts custom score functions and breaker options', async () => {
    const mock = createMockTransport({ getSlot: 5n });
    const { transport, health } = createResilientTransport({
      endpoints: [{ id: 'a', url: 'https://a', transport: mock }],
      scoreFn: () => 0.42,
      breaker: { failureThreshold: 1 },
      requestTimeoutMs: 5000,
      retry: { maxAttempts: 1 },
      random: () => 0,
    });
    await transport({ payload: PAYLOAD });
    expect(health.get('a')!.score()).toBe(0.42);
  });
});
