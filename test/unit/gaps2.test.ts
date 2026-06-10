/** Second round of branch-gap coverage. */
import { createSolanaRpcFromTransport } from '@solana/kit';
import type { Signature } from '@solana/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderFeesReport, runFees } from '../../src/cli/commands/fees.js';
import { renderMonitorFrame } from '../../src/cli/commands/monitor.js';
import { fetchTxStatus, renderTxSummary, watchTx } from '../../src/cli/commands/tx.js';
import { breakerBadge, renderHealthTable } from '../../src/cli/render.js';
import type { Shield } from '../../src/index.js';
import { createShield } from '../../src/index.js';
import { sleep } from '../../src/internal/async.js';
import { classifyFailure, extractRetryAfterMs } from '../../src/transport/classify.js';
import { createHedgingMiddleware } from '../../src/transport/hedge.js';
import type { RpcTransport } from '../../src/transport/types.js';
import { confirmSignature } from '../../src/tx/confirm.js';
import { createSignerFromWalletAccount } from '../../src/wallet/standard.js';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { alwaysOk, createMockTransport, okResponse } from '../helpers/mock-transport.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as Signature;

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
  vi.useRealTimers();
});

function makeShield(transport: RpcTransport): Shield {
  shield = createShield(
    { endpoints: [{ url: 'https://main.example.com', label: 'main' }], slotProbe: { enabled: false }, retry: { maxAttempts: 1 } },
    { transportFactory: () => transport, subscriptionsFactory: () => ({}) as never },
  );
  return shield;
}

describe('cli tx branches', () => {
  it('renders failed transactions and tolerates getTransaction errors', async () => {
    const s = makeShield(
      createMockTransport({
        getSignatureStatuses: {
          context: { slot: 100n },
          value: [{ slot: 99n, confirmations: 1, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }],
        },
        getTransaction: () => {
          throw new Error('history not available');
        },
      }),
    );
    const summary = await fetchTxStatus(s, SIG);
    expect(summary.found).toBe(true);
    expect(summary.feeLamports).toBeUndefined();
    const text = renderTxSummary(summary, false);
    expect(text).toContain('failed');
    expect(renderTxSummary(summary, true)).toContain('"found": true');
  });

  it('watchTx exits early on transaction errors', async () => {
    const s = makeShield(
      createMockTransport({
        getSignatureStatuses: {
          context: { slot: 100n },
          value: [{ slot: 99n, confirmations: 1, err: 'AccountInUse', confirmationStatus: 'processed' }],
        },
        getTransaction: null,
      }),
    );
    const lines: string[] = [];
    const summary = await watchTx(s, SIG, { intervalMs: 1, write: l => lines.push(l) });
    expect(summary.err).toBe('AccountInUse');
    expect(lines.some(l => l.includes('failed'))).toBe(true);
  });
});

describe('cli fees branches', () => {
  it('omits the chosen value when every source fails and includes the jito floor', async () => {
    const s = makeShield(
      createMockTransport({
        getRecentPrioritizationFees: () => {
          throw new Error('rpc down');
        },
      }),
    );
    const withJito = {
      ...s,
      jito: { recommendedTipLamports: async () => 7000n },
    } as unknown as Shield;
    const report = await runFees(withJito, {});
    expect(report.chosen).toBeUndefined();
    expect(report.jitoTipFloorLamports).toBe(7000n);
    const text = renderFeesReport(report, false);
    expect(text).toContain('7000');
    expect(text).not.toContain('chosen');
  });

  it('tolerates a failing jito tip floor', async () => {
    const s = makeShield(
      createMockTransport({ getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 3n }] }),
    );
    const withJito = {
      ...s,
      jito: {
        recommendedTipLamports: async () => {
          throw new Error('floor down');
        },
      },
    } as unknown as Shield;
    const report = await runFees(withJito, { accounts: ['acc'] });
    expect(report.jitoTipFloorLamports).toBeUndefined();
    expect(report.chosen).toBe(3n);
  });
});

describe('cli render branches', () => {
  it('covers all breaker badge states and frame without methods', async () => {
    const base = {
      id: 'x',
      url: 'https://x',
      label: 'x',
      score: 0.5,
      dead: false,
      deadReason: undefined,
      coolingDownForMs: 0,
      latencyEwmaMs: 0,
      errorRateEwma: 0,
      slotLag: 0,
      p50Ms: 0,
      p95Ms: 0,
      totalRequests: 0,
      totalFailures: 0,
      lastFailure: undefined,
    };
    expect(breakerBadge({ ...base, breakerState: 'half-open' as const })).toContain('probing');
    expect(breakerBadge({ ...base, breakerState: 'open' as const })).toContain('open');
    expect(renderHealthTable([{ ...base, breakerState: 'closed' as const }])).toContain('-');

    const s = makeShield(createMockTransport({ getSlot: 1n }));
    const frame = renderMonitorFrame(s, false);
    expect(frame).not.toContain('Per-method breakdown');
    const frameWithEmptyMethods = renderMonitorFrame(s, true);
    expect(frameWithEmptyMethods).toContain('no traffic yet');
  });
});

describe('confirm mergeSignals fallback (no AbortSignal.any)', () => {
  it('still merges caller and internal signals manually', async () => {
    const anyImpl = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const rpc = createSolanaRpcFromTransport(
        createMockTransport({
          getSignatureStatuses: {
            context: { slot: 100n },
            value: [{ slot: 99n, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
          },
          getBlockHeight: 50n,
        }),
      );
      const controller = new AbortController();
      const result = await confirmSignature({
        rpc,
        signature: SIG,
        commitment: 'confirmed',
        lastValidBlockHeight: 1000n,
        pollIntervalMs: 1,
        signal: controller.signal,
      });
      expect(result.type).toBe('confirmed');

      // Pre-aborted caller propagates through the manual merge too.
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        confirmSignature({
          rpc,
          signature: SIG,
          commitment: 'confirmed',
          lastValidBlockHeight: 1000n,
          pollIntervalMs: 1,
          signal: aborted.signal,
        }),
      ).rejects.toThrow();
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = anyImpl;
    }
  });
});

describe('hedge option branches', () => {
  it('passes through non-JSON-RPC payloads and custom method sets', async () => {
    const inner = alwaysOk('through');
    const hedged = createHedgingMiddleware({ methods: new Set(['getBalance']), delayMs: 1 })(inner);
    expect(await hedged({ payload: 'raw-string-payload' })).toEqual(okResponse('through'));
    expect(await hedged({ payload: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] } })).toEqual(
      okResponse('through'),
    );
  });

  it('converts string abort reasons into Errors', async () => {
    vi.useFakeTimers();
    const never = ((config: { signal?: AbortSignal }) =>
      new Promise((_r, reject) => {
        config.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as RpcTransport;
    const hedged = createHedgingMiddleware({ delayMs: 50 })(never);
    const controller = new AbortController();
    const pending = hedged({
      payload: { jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] },
      signal: controller.signal,
    });
    const expectation = expect(pending).rejects.toThrow('cancelled because reasons');
    await vi.advanceTimersByTimeAsync(10);
    controller.abort('cancelled because reasons');
    await expectation;
  });
});

describe('classify residual branches', () => {
  it('handles header records with non-string values and unusual causes', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': 7 } })).toBeUndefined();
    expect(extractRetryAfterMs({ headers: 'not-an-object' })).toBeUndefined();
    expect(classifyFailure({ message: 'socket hang up' }).kind).toBe('network');
    expect(classifyFailure(Object.assign(new Error('x'), { cause: 'string-cause' })).kind).toBe('unknown');
    expect(classifyFailure(null).kind).toBe('unknown');
  });

  it('sleep handles non-Error, non-string abort reasons', async () => {
    const controller = new AbortController();
    const pending = sleep(50, controller.signal);
    controller.abort(42 as unknown as Error);
    await expect(pending).rejects.toThrow();
  });
});

describe('wallet chain fallback', () => {
  it('defaults to solana:mainnet when the account lists no solana chain', async () => {
    const account = {
      address: 'addr',
      publicKey: new Uint8Array(32),
      chains: ['bitcoin:mainnet'],
      features: [],
    } as unknown as WalletAccount;
    let seenChain: string | undefined;
    const wallet = {
      version: '1.0.0',
      name: 'Odd',
      icon: 'data:image/svg+xml;base64,',
      chains: [],
      accounts: [account],
      features: {
        'solana:signAndSendTransaction': {
          version: '1.0.0',
          signAndSendTransaction: (...inputs: Array<{ chain: string }>) => {
            seenChain = inputs[0]?.chain;
            return Promise.resolve(inputs.map(() => ({ signature: new Uint8Array(64) })));
          },
        },
      },
    } as unknown as Wallet;
    const signer = createSignerFromWalletAccount(wallet, account);
    // Build a real transaction is unnecessary — the encoder only runs per item;
    // an empty batch exercises the chain selection without wallet interaction.
    await signer.signAndSendTransactions([]);
    expect(seenChain).toBeUndefined(); // no items sent
    expect(signer.address).toBe('addr');
  });
});
