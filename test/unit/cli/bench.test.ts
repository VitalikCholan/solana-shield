import { afterEach, describe, expect, it } from 'vitest';
import { renderBenchReport, runBench } from '../../../src/cli/commands/bench.js';
import type { Shield } from '../../../src/index.js';
import { createShield } from '../../../src/index.js';
import { createMockTransport } from '../../helpers/mock-transport.js';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
});

describe('bench', () => {
  it('benchmarks every endpoint with latency percentiles and failure counts', async () => {
    const good = createMockTransport({ getSlot: 1n });
    const flaky = createMockTransport({
      getSlot: (_p: unknown, i: number) => {
        if (i % 2 === 0) throw new Error('boom');
        return 1n;
      },
    });
    const queue = [good, flaky];
    shield = createShield(
      {
        endpoints: [
          { url: 'https://good.example.com', label: 'good' },
          { url: 'https://flaky.example.com', label: 'flaky' },
        ],
        slotProbe: { enabled: false },
      },
      { transportFactory: () => queue.shift()!, subscriptionsFactory: () => ({}) as never },
    );

    const results = await runBench(shield, { requests: 20, concurrency: 4 });
    const byLabel = Object.fromEntries(results.map(r => [r.label, r]));
    expect(byLabel['good']).toMatchObject({ requests: 20, failures: 0 });
    expect(byLabel['flaky']!.failures).toBe(10);
    expect(byLabel['good']!.throughputRps).toBeGreaterThan(0);
    expect(good.calls).toHaveLength(20);

    const text = stripAnsi(renderBenchReport(results, false));
    expect(text).toContain('good');
    expect(text).toContain('req/s');
    const json = JSON.parse(renderBenchReport(results, true)) as unknown[];
    expect(json).toHaveLength(2);
  });

  it('benchmarks a custom method', async () => {
    const mock = createMockTransport({ getLatestBlockhash: { ok: true } });
    shield = createShield(
      { endpoints: [{ url: 'https://x.example.com', label: 'x' }], slotProbe: { enabled: false } },
      { transportFactory: () => mock, subscriptionsFactory: () => ({}) as never },
    );
    await runBench(shield, { requests: 3, method: 'getLatestBlockhash' });
    expect(mock.callsFor('getLatestBlockhash')).toHaveLength(3);
  });
});
