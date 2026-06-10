import { createSolanaRpcFromTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { createNativeFeeSource } from '../../../src/fees/sources/native.js';
import { createMockTransport } from '../../helpers/mock-transport.js';

function makeSource(fees: bigint[]) {
  const transport = createMockTransport({
    getRecentPrioritizationFees: fees.map((prioritizationFee, i) => ({
      slot: BigInt(1000 + i),
      prioritizationFee,
    })),
  });
  return { source: createNativeFeeSource(createSolanaRpcFromTransport(transport)), transport };
}

describe('createNativeFeeSource', () => {
  it('takes the median of nonzero fees at medium level', async () => {
    const { source } = makeSource([0n, 100n, 200n, 300n, 0n]);
    const fee = await source.estimate({ writableAddresses: ['a'], level: 'medium' }, {});
    expect(fee).toBe(200n);
  });

  it('scales quantiles by level', async () => {
    const fees = Array.from({ length: 100 }, (_, i) => BigInt(i + 1));
    const { source } = makeSource(fees);
    expect(await source.estimate({ writableAddresses: [], level: 'low' }, {})).toBe(25n);
    expect(await source.estimate({ writableAddresses: [], level: 'high' }, {})).toBe(75n);
    expect(await source.estimate({ writableAddresses: [], level: 'veryHigh' }, {})).toBe(95n);
  });

  it('returns 1 µlamport when there is no nonzero fee data', async () => {
    const { source } = makeSource([0n, 0n]);
    expect(await source.estimate({ writableAddresses: [], level: 'medium' }, {})).toBe(1n);
  });

  it('caps the address list at 128 entries', async () => {
    const { source, transport } = makeSource([5n]);
    const many = Array.from({ length: 200 }, (_, i) => `addr-${i}`);
    await source.estimate({ writableAddresses: many, level: 'medium' }, {});
    const sent = transport.callsFor('getRecentPrioritizationFees')[0]!.params as unknown[];
    expect((sent[0] as unknown[]).length).toBe(128);
  });
});
