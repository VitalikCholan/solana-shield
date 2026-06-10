import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  classifyHttpStatus,
  classifyRpcErrorResponse,
  extractRetryAfterMs,
} from '../../../src/transport/classify.js';
import {
  TransportTimeoutError,
  isJsonRpcErrorResponse,
  isJsonRpcPayload,
} from '../../../src/transport/types.js';

/** Mimics the shape of kit's SolanaError for HTTP transport failures. */
function kitHttpError(statusCode: number, headers?: Record<string, string>): Error {
  const err = new Error(`HTTP error (${statusCode})`);
  Object.assign(err, { context: { __code: 123, statusCode, headers } });
  return err;
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

describe('classifyFailure', () => {
  it('classifies our own timeout as retryable + rotate', () => {
    const f = classifyFailure(new TransportTimeoutError(5000));
    expect(f).toMatchObject({ kind: 'timeout', retryable: true, rotateEndpoint: true, markDead: false });
  });

  it('classifies DOMException TimeoutError as timeout', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(classifyFailure(err).kind).toBe('timeout');
  });

  it('classifies a caller-initiated abort as non-retryable', () => {
    const f = classifyFailure(abortError());
    expect(f).toMatchObject({ kind: 'abort', retryable: false, rotateEndpoint: false });
  });

  it('classifies an abort caused by our per-attempt timeout as timeout', () => {
    const f = classifyFailure(abortError(), { timedOut: true });
    expect(f).toMatchObject({ kind: 'timeout', retryable: true, rotateEndpoint: true });
  });

  describe('HTTP statuses', () => {
    const table: Array<{
      status: number;
      retryable: boolean;
      rotate: boolean;
      markDead?: boolean;
    }> = [
      { status: 429, retryable: true, rotate: true },
      { status: 401, retryable: false, rotate: true, markDead: true },
      { status: 403, retryable: false, rotate: true, markDead: true },
      { status: 404, retryable: false, rotate: true, markDead: true },
      { status: 410, retryable: false, rotate: true, markDead: true },
      { status: 408, retryable: true, rotate: true },
      { status: 500, retryable: true, rotate: true },
      { status: 502, retryable: true, rotate: true },
      { status: 503, retryable: true, rotate: true },
      { status: 504, retryable: true, rotate: true },
      { status: 522, retryable: true, rotate: true },
      { status: 400, retryable: false, rotate: false },
      { status: 413, retryable: false, rotate: false },
    ];
    it.each(table)('HTTP $status → retryable=$retryable rotate=$rotate', t => {
      const f = classifyFailure(kitHttpError(t.status));
      expect(f.kind).toBe('http');
      expect(f.httpStatus).toBe(t.status);
      expect(f.retryable).toBe(t.retryable);
      expect(f.rotateEndpoint).toBe(t.rotate);
      expect(f.markDead).toBe(t.markDead ?? false);
    });
  });

  it('extracts Retry-After seconds into cooldownMs on 429', () => {
    const f = classifyFailure(kitHttpError(429, { 'Retry-After': '7' }));
    expect(f.cooldownMs).toBe(7000);
  });

  it('extracts status from plain `status`/`statusCode` error shapes', () => {
    expect(classifyFailure(Object.assign(new Error('x'), { status: 503 })).httpStatus).toBe(503);
    expect(classifyFailure(Object.assign(new Error('x'), { statusCode: 429 })).httpStatus).toBe(429);
  });

  describe('network errors', () => {
    it.each([
      ['fetch TypeError', new TypeError('fetch failed')],
      ['node code on error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
      ['node code on cause', Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } })],
      ['undici connect timeout', Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })],
    ])('%s → network/retryable/rotate', (_label, err) => {
      const f = classifyFailure(err);
      expect(f).toMatchObject({ kind: 'network', retryable: true, rotateEndpoint: true });
    });
  });

  it('treats unknown errors as non-retryable', () => {
    const f = classifyFailure(new RangeError('something else'));
    expect(f).toMatchObject({ kind: 'unknown', retryable: false, rotateEndpoint: false });
  });

  it('stringifies non-Error causes into the message', () => {
    expect(classifyFailure('boom').message).toBe('boom');
  });
});

describe('classifyHttpStatus', () => {
  it('passes an explicit retryAfterMs through for 429', () => {
    const f = classifyHttpStatus(429, undefined, 1234);
    expect(f.cooldownMs).toBe(1234);
  });
  it('omits cooldownMs when no hint is available', () => {
    expect(classifyHttpStatus(429, undefined).cooldownMs).toBeUndefined();
  });
});

describe('classifyRpcErrorResponse', () => {
  it.each([-32004, -32005, -32008, -32010, -32011, -32014, -32016])(
    'flags node-health code %i as retryable + rotate',
    code => {
      const f = classifyRpcErrorResponse({ jsonrpc: '2.0', id: 1, error: { code, message: 'node is behind' } });
      expect(f).toMatchObject({ kind: 'rpc', retryable: true, rotateEndpoint: true, rpcErrorCode: code });
    },
  );

  it('flags rate-limit-flavored messages regardless of code', () => {
    const f = classifyRpcErrorResponse({ error: { code: -32000, message: 'Too many requests for this minute' } });
    expect(f).toMatchObject({ retryable: true, rotateEndpoint: true });
  });

  it.each([
    ['invalid params', { error: { code: -32602, message: 'Invalid params' } }],
    ['method not found', { error: { code: -32601, message: 'Method not found' } }],
    ['preflight failure', { error: { code: -32002, message: 'Transaction simulation failed' } }],
    ['slot skipped', { error: { code: -32007, message: 'Slot 1 was skipped' } }],
  ])('passes application-level error through: %s', (_label, response) => {
    expect(classifyRpcErrorResponse(response)).toBeUndefined();
  });

  it('returns undefined for result responses and junk', () => {
    expect(classifyRpcErrorResponse({ jsonrpc: '2.0', id: 1, result: 42 })).toBeUndefined();
    expect(classifyRpcErrorResponse(null)).toBeUndefined();
    expect(classifyRpcErrorResponse('nope')).toBeUndefined();
    expect(classifyRpcErrorResponse({ error: { code: 'NaN' } })).toBeUndefined();
  });
});

describe('extractRetryAfterMs', () => {
  it('reads from a Headers instance (case-insensitive)', () => {
    const err = { context: { headers: new Headers({ 'Retry-After': '2' }) } };
    expect(extractRetryAfterMs(err)).toBe(2000);
  });
  it('reads from a plain record', () => {
    expect(extractRetryAfterMs({ headers: { 'retry-after': '3' } })).toBe(3000);
  });
  it('parses an HTTP-date into a future delta', () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const ms = extractRetryAfterMs({ headers: { 'Retry-After': future } });
    expect(ms).toBeGreaterThan(50_000);
    expect(ms).toBeLessThanOrEqual(61_000);
  });
  it('returns undefined for garbage and missing headers', () => {
    expect(extractRetryAfterMs({ headers: { 'Retry-After': 'soon-ish' } })).toBeUndefined();
    expect(extractRetryAfterMs({ headers: {} })).toBeUndefined();
    expect(extractRetryAfterMs({})).toBeUndefined();
    expect(extractRetryAfterMs(null)).toBeUndefined();
  });
});

describe('type guards', () => {
  it('isJsonRpcPayload', () => {
    expect(isJsonRpcPayload({ jsonrpc: '2.0', id: 1, method: 'getSlot' })).toBe(true);
    expect(isJsonRpcPayload({ jsonrpc: '1.0', id: 1, method: 'getSlot' })).toBe(false);
    expect(isJsonRpcPayload(null)).toBe(false);
  });
  it('isJsonRpcErrorResponse', () => {
    expect(isJsonRpcErrorResponse({ error: { code: -1 } })).toBe(true);
    expect(isJsonRpcErrorResponse({ result: 1 })).toBe(false);
    expect(isJsonRpcErrorResponse(undefined)).toBe(false);
  });
});
