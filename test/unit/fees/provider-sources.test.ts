import { describe, expect, it } from 'vitest';
import { createHeliusFeeSource } from '../../../src/fees/sources/helius.js';
import { createQuickNodeFeeSource } from '../../../src/fees/sources/quicknode.js';
import { createTritonFeeSource } from '../../../src/fees/sources/triton.js';
import { createMockTransport } from '../../helpers/mock-transport.js';

describe('createHeliusFeeSource', () => {
  it('parses priorityFeeEstimate and rounds up to a bigint', async () => {
    const transport = createMockTransport({
      getPriorityFeeEstimate: { result: { priorityFeeEstimate: 1234.4 } },
    });
    const fee = await createHeliusFeeSource(transport).estimate(
      { writableAddresses: ['acc1'], level: 'medium' },
      {},
    );
    expect(fee).toBe(1235n);
    const call = transport.callsFor('getPriorityFeeEstimate')[0]!;
    const params = (call.params as unknown[])[0] as Record<string, unknown>;
    expect(params['accountKeys']).toEqual(['acc1']);
    expect((params['options'] as Record<string, unknown>)['priorityLevel']).toBe('Medium');
  });

  it('maps veryHigh to VeryHigh', async () => {
    const transport = createMockTransport({
      getPriorityFeeEstimate: { result: { priorityFeeEstimate: 1 } },
    });
    await createHeliusFeeSource(transport).estimate({ writableAddresses: [], level: 'veryHigh' }, {});
    const params = (transport.calls[0]!.params as unknown[])[0] as Record<string, unknown>;
    expect((params['options'] as Record<string, unknown>)['priorityLevel']).toBe('VeryHigh');
  });

  it('throws a descriptive error on RPC error responses', async () => {
    const transport = createMockTransport({
      getPriorityFeeEstimate: { error: { code: -32601, message: 'Method not found' } },
    });
    await expect(
      createHeliusFeeSource(transport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/helius.*Method not found/);
  });
});

describe('createQuickNodeFeeSource', () => {
  const result = { per_compute_unit: { low: 10, medium: 20.2, high: 30, extreme: 40 } };

  it('selects the level band from per_compute_unit', async () => {
    const transport = createMockTransport({ qn_estimatePriorityFees: { result } });
    const sourceFee = await createQuickNodeFeeSource(transport).estimate(
      { writableAddresses: ['acc1'], level: 'medium' },
      {},
    );
    expect(sourceFee).toBe(21n);
    const params = transport.calls[0]!.params as Record<string, unknown>;
    expect(params['account']).toBe('acc1');
    expect(params['api_version']).toBe(2);
  });

  it('maps veryHigh to extreme', async () => {
    const transport = createMockTransport({ qn_estimatePriorityFees: { result } });
    const fee = await createQuickNodeFeeSource(transport).estimate(
      { writableAddresses: [], level: 'veryHigh' },
      {},
    );
    expect(fee).toBe(40n);
  });

  it('throws when the add-on is missing', async () => {
    const transport = createMockTransport({
      qn_estimatePriorityFees: { error: { code: -32601, message: 'method not enabled' } },
    });
    await expect(
      createQuickNodeFeeSource(transport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/quicknode/);
  });
});

describe('createTritonFeeSource', () => {
  it('passes the percentile extension and takes the median of nonzero fees', async () => {
    const transport = createMockTransport({
      getRecentPrioritizationFees: {
        result: [
          { slot: 1, prioritizationFee: 0 },
          { slot: 2, prioritizationFee: 100 },
          { slot: 3, prioritizationFee: 300 },
          { slot: 4, prioritizationFee: 200 },
        ],
      },
    });
    const fee = await createTritonFeeSource(transport).estimate(
      { writableAddresses: ['acc1'], level: 'medium' },
      {},
    );
    expect(fee).toBe(200n);
    const params = transport.calls[0]!.params as unknown[];
    expect(params[0]).toEqual(['acc1']);
    expect((params[1] as Record<string, unknown>)['percentile']).toBe(5000);
  });

  it('maps levels to percentile basis points', async () => {
    const transport = createMockTransport({
      getRecentPrioritizationFees: { result: [{ slot: 1, prioritizationFee: 5 }] },
    });
    await createTritonFeeSource(transport).estimate({ writableAddresses: [], level: 'veryHigh' }, {});
    expect(((transport.calls[0]!.params as unknown[])[1] as Record<string, unknown>)['percentile']).toBe(9500);
  });

  it('returns 1 µlamport for an all-zero window and throws on malformed responses', async () => {
    const zeroTransport = createMockTransport({
      getRecentPrioritizationFees: { result: [{ slot: 1, prioritizationFee: 0 }] },
    });
    expect(
      await createTritonFeeSource(zeroTransport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).toBe(1n);
    const badTransport = createMockTransport({
      getRecentPrioritizationFees: { error: { code: -32602, message: 'no percentile support' } },
    });
    await expect(
      createTritonFeeSource(badTransport).estimate({ writableAddresses: [], level: 'low' }, {}),
    ).rejects.toThrow(/triton/);
  });
});
