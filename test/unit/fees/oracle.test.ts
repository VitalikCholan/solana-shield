import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeeOracle } from '../../../src/fees/oracle.js';
import type { FeeEstimateRequest, FeeSource } from '../../../src/fees/types.js';
import { sleep } from '../../../src/internal/async.js';

const REQUEST: FeeEstimateRequest = { writableAddresses: ['a', 'b'], level: 'medium' };

function source(name: string, fn: FeeSource['estimate']): FeeSource {
  return { name, estimate: fn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('FeeOracle', () => {
  it('aggregates with max-of-responses', async () => {
    const oracle = new FeeOracle([
      source('a', async () => 100n),
      source('b', async () => 300n),
      source('c', async () => 200n),
    ]);
    expect(await oracle.estimate(REQUEST, {})).toBe(300n);
    expect(oracle.name).toBe('oracle(a+b+c)');
  });

  it('ignores failing sources as long as one responds', async () => {
    const oracle = new FeeOracle([
      source('down', async () => {
        throw new Error('api down');
      }),
      source('up', async () => 222n),
    ]);
    expect(await oracle.estimate(REQUEST, {})).toBe(222n);
  });

  it('throws when every source fails', async () => {
    const oracle = new FeeOracle([
      source('down', async () => {
        throw new Error('api down');
      }),
    ]);
    await expect(oracle.estimate(REQUEST, {})).rejects.toThrow(/all fee sources failed/i);
  });

  it('rejects construction with zero sources', () => {
    expect(() => new FeeOracle([])).toThrow(/at least one/i);
  });

  it('cuts off sources that miss the time budget', async () => {
    vi.useFakeTimers();
    const oracle = new FeeOracle(
      [
        source('fast', async () => 50n),
        source('slow', async (_req, ctx) => {
          await sleep(5000, ctx.signal);
          return 9999n;
        }),
      ],
      { budgetMs: 400 },
    );
    const pending = oracle.estimate(REQUEST, {});
    await vi.advanceTimersByTimeAsync(401);
    expect(await pending).toBe(50n);
  });

  it('caches estimates for the TTL window', async () => {
    let time = 0;
    let calls = 0;
    const oracle = new FeeOracle(
      [
        source('counted', async () => {
          calls += 1;
          return 10n;
        }),
      ],
      { cacheTtlMs: 2000, now: () => time },
    );
    await oracle.estimate(REQUEST, {});
    await oracle.estimate(REQUEST, {});
    expect(calls).toBe(1);
    time = 2001;
    await oracle.estimate(REQUEST, {});
    expect(calls).toBe(2);
  });

  it('keys the cache by level and addresses', async () => {
    let calls = 0;
    const oracle = new FeeOracle([
      source('counted', async () => {
        calls += 1;
        return 10n;
      }),
    ]);
    await oracle.estimate(REQUEST, {});
    await oracle.estimate({ ...REQUEST, level: 'high' }, {});
    expect(calls).toBe(2);
  });

  it('floors the aggregate at 1 µlamport', async () => {
    const oracle = new FeeOracle([source('zero', async () => 0n)]);
    expect(await oracle.estimate(REQUEST, {})).toBe(1n);
  });

  it('compare() reports per-source values and errors', async () => {
    const oracle = new FeeOracle([
      source('good', async () => 5n),
      source('bad', async () => {
        throw new Error('nope');
      }),
    ]);
    const rows = await oracle.compare(REQUEST);
    expect(rows).toEqual([
      { source: 'good', value: 5n },
      { source: 'bad', error: 'nope' },
    ]);
  });
});
