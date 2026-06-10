/** Final branch-gap round. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolanaRpcFromTransport } from '@solana/kit';
import type { Signature } from '@solana/kit';
import { afterEach, describe, expect, it } from 'vitest';
import { loadCliConfig } from '../../src/cli/config.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { runMonitor } from '../../src/cli/commands/monitor.js';
import { fetchTxStatus, renderTxSummary } from '../../src/cli/commands/tx.js';
import { createNativeFeeSource } from '../../src/fees/sources/native.js';
import { createQuickNodeFeeSource } from '../../src/fees/sources/quicknode.js';
import { createTritonFeeSource } from '../../src/fees/sources/triton.js';
import type { Shield } from '../../src/index.js';
import { createShield } from '../../src/index.js';
import { startRebroadcast } from '../../src/tx/rebroadcast.js';
import type { RpcTransport } from '../../src/transport/types.js';
import { createMockTransport } from '../helpers/mock-transport.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW' as Signature;

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
});

function makeShield(transport: RpcTransport): Shield {
  shield = createShield(
    { endpoints: [{ url: 'https://main.example.com', label: 'main' }], slotProbe: { enabled: false }, retry: { maxAttempts: 1 } },
    { transportFactory: () => transport, subscriptionsFactory: () => ({}) as never },
  );
  return shield;
}

describe('fee sources: tie-breaking and sparse data', () => {
  it('native handles all-equal fee distributions', async () => {
    const transport = createMockTransport({
      getRecentPrioritizationFees: [
        { slot: 1n, prioritizationFee: 5n },
        { slot: 2n, prioritizationFee: 5n },
        { slot: 3n, prioritizationFee: 5n },
      ],
    });
    const source = createNativeFeeSource(createSolanaRpcFromTransport(transport));
    expect(await source.estimate({ writableAddresses: [], level: 'veryHigh' }, {})).toBe(5n);
  });

  it('triton handles equal fees and single entries', async () => {
    const transport = createMockTransport({
      getRecentPrioritizationFees: {
        result: [
          { slot: 1, prioritizationFee: 9 },
          { slot: 2, prioritizationFee: 9 },
        ],
      },
    });
    expect(
      await createTritonFeeSource(transport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).toBe(9n);
  });

  it('quicknode reports code-only errors', async () => {
    const transport = createMockTransport({ qn_estimatePriorityFees: { error: { code: -32099 } } });
    await expect(
      createQuickNodeFeeSource(transport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/-32099/);
  });
});

describe('cli tx: sparse statuses', () => {
  it('handles statuses without confirmationStatus', async () => {
    const s = makeShield(
      createMockTransport({
        getSignatureStatuses: {
          context: { slot: 100n },
          value: [{ slot: 99n, confirmations: null, err: null, confirmationStatus: null }],
        },
        getTransaction: null,
      }),
    );
    const summary = await fetchTxStatus(s, SIG);
    expect(summary.found).toBe(true);
    expect(summary.confirmationStatus).toBeUndefined();
    expect(renderTxSummary(summary, false)).toContain('processed');
  });
});

describe('cli config: cwd discovery and minimal files', () => {
  it('discovers solana-shield.config.json in the working directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shield-cwd-'));
    const previous = process.cwd();
    try {
      writeFileSync(join(dir, 'solana-shield.config.json'), JSON.stringify({ endpoints: ['testnet'] }));
      process.chdir(dir);
      const config = loadCliConfig({}, {});
      expect(config.endpoints).toEqual(['testnet']);
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes through config files without a fees section', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shield-nofees-'));
    try {
      const path = join(dir, 'c.json');
      writeFileSync(path, JSON.stringify({ endpoints: ['devnet'], coalescing: true }));
      const config = loadCliConfig({ config: path }, {});
      expect(config.coalescing).toBe(true);
      expect(config.fees).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles fee sections without a ceiling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shield-feeceil-'));
    try {
      const path = join(dir, 'c.json');
      writeFileSync(path, JSON.stringify({ endpoints: ['devnet'], fees: { level: 'low' } }));
      const config = loadCliConfig({ config: path }, {});
      expect(config.fees?.level).toBe('low');
      expect(config.fees?.maxMicroLamportsPerCu).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('doctor: endpoint with version but no slot', () => {
  it('marks slotless endpoints as not agreeing', async () => {
    const s = makeShield(
      createMockTransport({
        getVersion: { 'solana-core': '2.0.0' },
        getSlot: { result: undefined },
        getRecentPrioritizationFees: [{ slot: 1n, prioritizationFee: 1n }],
      }),
    );
    const report = await runDoctor(s, { wsCheck: false });
    expect(report.endpoints[0]!.reachable).toBe(true);
    expect(report.endpoints[0]!.slot).toBeUndefined();
    expect(report.endpoints[0]!.agreesWithPool).toBe(false);
  });
});

describe('monitor with methods enabled end-to-end', () => {
  it('renders method stats inside the loop', async () => {
    const s = makeShield(createMockTransport({ getSlot: 7n }));
    await s.rpc.getSlot().send();
    const controller = new AbortController();
    const frames: string[] = [];
    const done = runMonitor(s, {
      intervalMs: 5,
      methods: true,
      write: text => frames.push(text),
      signal: controller.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 15));
    controller.abort();
    await done;
    expect(frames[0]).toContain('Per-method breakdown');
  });
});

describe('rebroadcast without an onError handler', () => {
  it('swallows send errors silently', async () => {
    const controller = new AbortController();
    let calls = 0;
    const loop = startRebroadcast({
      send: async () => {
        calls += 1;
        throw new Error('always fails');
      },
      intervalMs: 1,
      signal: controller.signal,
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    controller.abort();
    await loop;
    expect(calls).toBeGreaterThan(0);
  });
});
