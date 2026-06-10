import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, computeBackoffMs } from '../../../src/transport/retry.js';

describe('computeBackoffMs', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000 };

  it('uses full jitter within the exponential ceiling', () => {
    expect(computeBackoffMs(policy, 0, () => 1)).toBe(100);
    expect(computeBackoffMs(policy, 1, () => 1)).toBe(200);
    expect(computeBackoffMs(policy, 2, () => 1)).toBe(400);
    expect(computeBackoffMs(policy, 0, () => 0)).toBe(0);
    expect(computeBackoffMs(policy, 2, () => 0.5)).toBe(200);
  });

  it('caps the ceiling at maxDelayMs', () => {
    expect(computeBackoffMs(policy, 10, () => 1)).toBe(1000);
  });

  it('has sane defaults', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_RETRY_POLICY.maxDelayMs).toBeGreaterThan(DEFAULT_RETRY_POLICY.baseDelayMs);
  });
});
