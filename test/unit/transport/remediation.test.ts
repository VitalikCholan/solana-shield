import { describe, expect, it } from 'vitest';
import { AllEndpointsFailedError, suggestRemediation } from '../../../src/transport/types.js';
import type { ClassifiedFailure } from '../../../src/transport/types.js';

function failure(overrides: Partial<ClassifiedFailure>): ClassifiedFailure {
  return {
    kind: 'network',
    retryable: true,
    rotateEndpoint: true,
    markDead: false,
    message: 'fetch failed',
    cause: undefined,
    ...overrides,
  };
}

describe('suggestRemediation', () => {
  it('flags auth/url problems when any endpoint is dead', () => {
    const hint = suggestRemediation([
      failure({ kind: 'http', httpStatus: 403, markDead: true, message: 'HTTP 403' }),
      failure({ kind: 'network' }),
    ]);
    expect(hint).toMatch(/API key and URL/i);
  });

  it('flags rate limiting when every failure is a 429', () => {
    const hint = suggestRemediation([
      failure({ kind: 'http', httpStatus: 429, message: 'HTTP 429 (rate limited)' }),
      failure({ kind: 'http', httpStatus: 429, message: 'HTTP 429 (rate limited)' }),
    ]);
    expect(hint).toMatch(/rate-limiting/i);
    expect(hint).toMatch(/rps/);
  });

  it('flags unreachable/timeout when every failure is network or timeout', () => {
    const hint = suggestRemediation([failure({ kind: 'network' }), failure({ kind: 'timeout' })]);
    expect(hint).toMatch(/unreachable or timed out/i);
    expect(hint).toMatch(/requestTimeoutMs/);
  });

  it('flags node-health lag when every failure is an rpc error', () => {
    const hint = suggestRemediation([
      failure({ kind: 'rpc', message: 'node behind' }),
      failure({ kind: 'rpc', message: 'node behind' }),
    ]);
    expect(hint).toMatch(/node-health/i);
  });

  it('gives a generic hint for mixed causes and empty input', () => {
    expect(suggestRemediation([failure({ kind: 'network' }), failure({ kind: 'rpc' })])).toMatch(
      /add more healthy endpoints/i,
    );
    expect(suggestRemediation([])).toBe('');
  });
});

describe('AllEndpointsFailedError', () => {
  it('appends the remediation hint to the message and exposes it', () => {
    const err = new AllEndpointsFailedError([
      failure({ kind: 'http', httpStatus: 429, message: 'HTTP 429 (rate limited)' }),
    ]);
    expect(err.remediation).toMatch(/rate-limiting/i);
    expect(err.message).toContain('→');
    expect(err.message).toContain('HTTP 429');
    expect(err.failures).toHaveLength(1);
  });
});
