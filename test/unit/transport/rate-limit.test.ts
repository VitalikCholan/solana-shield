import { describe, expect, it } from 'vitest';
import { TokenBucket, defaultRateLimitCooldownMs } from '../../../src/transport/rate-limit.js';

describe('TokenBucket', () => {
  it('allows up to burst immediately, then refuses', () => {
    const time = 0;
    const bucket = new TokenBucket(1, 2, () => time);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('refills at the configured rate', () => {
    let time = 0;
    const bucket = new TokenBucket(2, 2, () => time);
    bucket.tryRemove(2);
    expect(bucket.tryRemove()).toBe(false);
    time += 500; // 2/s → one token back after 500ms
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('never exceeds burst capacity', () => {
    let time = 0;
    const bucket = new TokenBucket(10, 2, () => time);
    time += 60_000;
    expect(bucket.tryRemove(2)).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  it('reports time until the next token', () => {
    let time = 0;
    const bucket = new TokenBucket(1, 1, () => time);
    expect(bucket.msUntilAvailable()).toBe(0);
    bucket.tryRemove();
    expect(bucket.msUntilAvailable()).toBe(1000);
    time += 400;
    expect(bucket.msUntilAvailable()).toBe(600);
  });
});

describe('defaultRateLimitCooldownMs', () => {
  it('grows exponentially and caps at 30s', () => {
    expect(defaultRateLimitCooldownMs(1)).toBe(1000);
    expect(defaultRateLimitCooldownMs(2)).toBe(2000);
    expect(defaultRateLimitCooldownMs(3)).toBe(4000);
    expect(defaultRateLimitCooldownMs(10)).toBe(30_000);
    expect(defaultRateLimitCooldownMs(0)).toBe(1000);
  });
});
