import type { RpcSubscriptions, SolanaRpcSubscriptionsApi } from '@solana/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDoctorReport, runDoctor } from '../../../src/cli/commands/doctor.js';
import { renderFeesReport, runFees } from '../../../src/cli/commands/fees.js';
import { renderMonitorFrame, runMonitor } from '../../../src/cli/commands/monitor.js';
import { fetchTxStatus, renderTxSummary, watchTx } from '../../../src/cli/commands/tx.js';
import type { Shield } from '../../../src/index.js';
import { createShield } from '../../../src/index.js';
import { createMockTransport } from '../../helpers/mock-transport.js';
import type { MockTransport } from '../../helpers/mock-transport.js';

 
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

function fakeSubscriptions(): RpcSubscriptions<SolanaRpcSubscriptionsApi> {
  return {} as RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

function goodHandlers(slot: bigint) {
  return {
    getVersion: { 'solana-core': '2.3.1', 'feature-set': 1 },
    getSlot: slot,
    getRecentPrioritizationFees: [{ slot, prioritizationFee: 100n }],
  };
}

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
});

function makeShield(transports: MockTransport[], labels: string[]): Shield {
  const queue = [...transports];
  shield = createShield(
    {
      endpoints: labels.map(label => ({ url: `https://${label}.example.com`, label })),
      slotProbe: { enabled: false },
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    },
    { transportFactory: () => queue.shift()!, subscriptionsFactory: fakeSubscriptions },
  );
  return shield;
}

describe('doctor', () => {
  it('reports reachability, slot agreement, fee sources, and overall health', async () => {
    const healthy = createMockTransport(goodHandlers(1000n));
    const lagging = createMockTransport(goodHandlers(900n)); // 100 slots behind
    const s = makeShield([healthy, lagging], ['healthy', 'lagging']);
    const report = await runDoctor(s, { wsCheck: false });

    const byLabel = Object.fromEntries(report.endpoints.map(e => [e.label, e]));
    expect(byLabel['healthy']).toMatchObject({ reachable: true, version: '2.3.1', slotLag: 0, agreesWithPool: true });
    expect(byLabel['lagging']).toMatchObject({ reachable: true, slotLag: 100, agreesWithPool: false });
    expect(report.fees.some(f => f.value === 100n)).toBe(true);
    expect(report.healthy).toBe(true);

    const text = stripAnsi(renderDoctorReport(report, false));
    expect(text).toContain('healthy');
    expect(text).toContain('✔ healthy');
    const json = JSON.parse(renderDoctorReport(report, true)) as { healthy: boolean };
    expect(json.healthy).toBe(true);
  });

  it('diagnoses auth failures and marks the report unhealthy when nothing agrees', async () => {
    const forbidden = createMockTransport({
      getVersion: () => {
        throw Object.assign(new Error('HTTP 403'), { context: { statusCode: 403 } });
      },
    });
    const s = makeShield([forbidden], ['secured']);
    const report = await runDoctor(s, { wsCheck: false });
    expect(report.endpoints[0]).toMatchObject({
      reachable: false,
      diagnosis: expect.stringMatching(/API key rejected/) as unknown,
    });
    expect(report.healthy).toBe(false);
    expect(stripAnsi(renderDoctorReport(report, false))).toContain('✘ problems detected');
  });
});

describe('fees command', () => {
  it('collects per-source estimates, the chosen value, and renders both formats', async () => {
    const s = makeShield([createMockTransport(goodHandlers(5n))], ['main']);
    const report = await runFees(s, { level: 'medium' });
    expect(report.sources[0]).toMatchObject({ source: 'native', value: 100n });
    expect(report.chosen).toBe(100n);
    const text = stripAnsi(renderFeesReport(report, false));
    expect(text).toContain('native');
    expect(text).toContain('100');
    expect(JSON.parse(renderFeesReport(report, true))).toMatchObject({ level: 'medium' });
  });
});

describe('tx command', () => {
  function txHandlers(status: string | null, err: unknown = null) {
    return {
      getSignatureStatuses: {
        context: { slot: 100n },
        value: [
          status === null ? null : { slot: 99n, confirmations: 1, err, confirmationStatus: status },
        ],
      },
      getTransaction: {
        slot: 99n,
        blockTime: 1750000000n,
        meta: { fee: 5000n, computeUnitsConsumed: 1500n, err: null },
        transaction: { signatures: [SIG], message: { instructions: [] } },
      },
    };
  }

  it('summarizes a confirmed transaction', async () => {
    const s = makeShield([createMockTransport(txHandlers('confirmed'))], ['main']);
    const summary = await fetchTxStatus(s, SIG);
    expect(summary).toMatchObject({
      found: true,
      confirmationStatus: 'confirmed',
      feeLamports: 5000n,
      computeUnitsConsumed: 1500n,
    });
    const text = stripAnsi(renderTxSummary(summary, false));
    expect(text).toContain('confirmed');
    expect(text).toContain('5000 lamports');
  });

  it('reports unknown signatures distinctly', async () => {
    const s = makeShield([createMockTransport(txHandlers(null))], ['main']);
    const summary = await fetchTxStatus(s, SIG);
    expect(summary.found).toBe(false);
    expect(stripAnsi(renderTxSummary(summary, false))).toContain('not found');
  });

  it('watches until finalized', async () => {
    const transport = createMockTransport({
      getSignatureStatuses: (_p: unknown, i: number) => ({
        context: { slot: 100n },
        value: [
          {
            slot: 99n,
            confirmations: 1,
            err: null,
            confirmationStatus: i < 2 ? 'confirmed' : 'finalized',
          },
        ],
      }),
      getTransaction: null,
    });
    const s = makeShield([transport], ['main']);
    const lines: string[] = [];
    const summary = await watchTx(s, SIG, { intervalMs: 1, write: line => lines.push(line) });
    expect(summary.confirmationStatus).toBe('finalized');
    expect(lines.some(l => l.includes('confirmed'))).toBe(true);
    expect(lines.some(l => l.includes('finalized'))).toBe(true);
  });
});

describe('monitor', () => {
  it('renders a frame with endpoint health and optional method stats', async () => {
    const s = makeShield([createMockTransport(goodHandlers(7n))], ['main']);
    await s.rpc.getSlot().send(); // generate some traffic
    const frame = stripAnsi(renderMonitorFrame(s, true));
    expect(frame).toContain('solana-shield monitor');
    expect(frame).toContain('main');
    expect(frame).toContain('Per-method breakdown');
    expect(frame).toContain('getSlot');
  });

  it('redraws on the interval until aborted', async () => {
    const s = makeShield([createMockTransport(goodHandlers(7n))], ['main']);
    const controller = new AbortController();
    const frames: string[] = [];
    const done = runMonitor(s, {
      intervalMs: 5,
      write: text => frames.push(text),
      signal: controller.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    await done;
    expect(frames.length).toBeGreaterThanOrEqual(2);
  });
});
