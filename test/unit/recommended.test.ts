import { afterEach, describe, expect, it } from 'vitest';
import type { Shield } from '../../src/index.js';
import { createRecommendedShield } from '../../src/index.js';
import { createMockTransport } from '../helpers/mock-transport.js';

let shield: Shield | undefined;
afterEach(() => {
  shield?.destroy();
  shield = undefined;
});

const fakeSubs = () => ({}) as never;

describe('createRecommendedShield', () => {
  it('builds a working resilient client from just endpoints', async () => {
    const transport = createMockTransport({ getSlot: 123n });
    shield = createRecommendedShield(['https://a.example.com'], { slotProbe: { enabled: false } }, {
      transportFactory: () => transport,
      subscriptionsFactory: fakeSubs,
    });
    expect(await shield.rpc.getSlot().send()).toBe(123n);
  });

  it('merges overrides over the recommended defaults', () => {
    const transport = createMockTransport({ getSlot: 1n });
    shield = createRecommendedShield(
      ['https://a.example.com'],
      { jito: { regions: ['frankfurt'] }, slotProbe: { enabled: false } },
      { transportFactory: () => transport, subscriptionsFactory: fakeSubs },
    );
    // Override took effect (Jito configured), proving the merge.
    expect(shield.jito?.label).toBe('jito:frankfurt');
    // Default endpoints still resolved.
    expect(shield.endpoints).toHaveLength(1);
  });
});
