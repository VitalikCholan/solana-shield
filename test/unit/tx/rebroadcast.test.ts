import { afterEach, describe, expect, it, vi } from 'vitest';
import { startRebroadcast } from '../../../src/tx/rebroadcast.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startRebroadcast', () => {
  it('resends on each interval tick until aborted', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempts: number[] = [];
    const resent: number[] = [];
    const loop = startRebroadcast({
      send: async attempt => {
        attempts.push(attempt);
      },
      intervalMs: 1000,
      signal: controller.signal,
      onResent: a => resent.push(a),
    });
    await vi.advanceTimersByTimeAsync(3100);
    controller.abort();
    await loop;
    expect(attempts).toEqual([1, 2, 3]);
    expect(resent).toEqual([1, 2, 3]);
    // No further sends after abort.
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempts).toEqual([1, 2, 3]);
  });

  it('keeps looping through send errors and reports them', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const errors: number[] = [];
    let calls = 0;
    const loop = startRebroadcast({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
      },
      intervalMs: 100,
      signal: controller.signal,
      onError: attempt => errors.push(attempt),
    });
    await vi.advanceTimersByTimeAsync(250);
    controller.abort();
    await loop;
    expect(calls).toBe(2);
    expect(errors).toEqual([1]);
  });

  it('stops immediately when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await startRebroadcast({
      send: async () => {
        calls += 1;
      },
      signal: controller.signal,
    });
    expect(calls).toBe(0);
  });
});
