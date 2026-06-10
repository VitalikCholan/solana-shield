import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../../src/transport/circuit-breaker.js';

function makeBreaker(overrides: Record<string, number> = {}) {
  let time = 0;
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    windowMs: 10_000,
    baseOpenMs: 1000,
    maxOpenMs: 8000,
    now: () => time,
    ...overrides,
  });
  return { breaker, advance: (ms: number) => (time += ms) };
}

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const { breaker } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('opens at the threshold and rejects acquisitions', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
  });

  it('ignores failures outside the rolling window', () => {
    const { breaker, advance } = makeBreaker();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(11_000);
    breaker.recordFailure();
    expect(breaker.state()).toBe('closed');
  });

  it('transitions to half-open after the open period and admits exactly one probe', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    advance(1001);
    expect(breaker.state()).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // only one probe at a time
  });

  it('closes after a successful half-open probe', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    advance(1001);
    breaker.tryAcquire();
    breaker.recordSuccess();
    expect(breaker.state()).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('reopens with exponential duration after a failed probe, capped at maxOpenMs', () => {
    const { breaker, advance } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure(); // trip 1: open 1000ms
    advance(1001);
    breaker.tryAcquire();
    breaker.recordFailure(); // trip 2: open 2000ms
    expect(breaker.state()).toBe('open');
    advance(1999);
    expect(breaker.state()).toBe('open');
    advance(2);
    expect(breaker.state()).toBe('half-open');
    breaker.tryAcquire();
    breaker.recordFailure(); // trip 3: open 4000ms
    advance(3999);
    expect(breaker.state()).toBe('open');
    advance(2);
    breaker.tryAcquire();
    breaker.recordFailure(); // trip 4: would be 8000 (cap)
    advance(7999);
    expect(breaker.state()).toBe('open');
    advance(2);
    expect(breaker.state()).toBe('half-open');
  });

  it('forceHalfOpen makes an open breaker immediately probeable', () => {
    const { breaker } = makeBreaker();
    for (let i = 0; i < 3; i++) breaker.recordFailure();
    expect(breaker.state()).toBe('open');
    breaker.forceHalfOpen();
    expect(breaker.state()).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('forceHalfOpen is a no-op when closed', () => {
    const { breaker } = makeBreaker();
    breaker.forceHalfOpen();
    expect(breaker.state()).toBe('closed');
  });
});
