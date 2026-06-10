/** Buffer tests to keep the branch threshold comfortably above 90%. */
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/chaos/prng.js';
import { JitoSender } from '../../src/jito/sender.js';
import { MetricsRegistry } from '../../src/telemetry/registry.js';
import { EndpointSelector } from '../../src/transport/balancer.js';
import { HealthRegistry } from '../../src/transport/health.js';
import type { ClassifiedFailure } from '../../src/transport/types.js';
import { alwaysOk } from '../helpers/mock-transport.js';

const rotateFailure: ClassifiedFailure = {
  kind: 'network',
  retryable: true,
  rotateEndpoint: true,
  markDead: false,
  message: 'fetch failed',
  cause: undefined,
};

describe('selector: every endpoint open AND excluded', () => {
  it('still returns a probe candidate', () => {
    const metrics = new MetricsRegistry();
    const registry = new HealthRegistry(
      [
        { id: 'a', url: 'https://a', transport: alwaysOk() },
        { id: 'b', url: 'https://b', transport: alwaysOk() },
      ],
      { metrics },
    );
    for (const endpoint of registry.all()) {
      for (let i = 0; i < 5; i++) endpoint.recordFailure(rotateFailure, 5, 'getSlot');
      expect(endpoint.breaker.state()).toBe('open');
    }
    const selector = new EndpointSelector(registry, mulberry32(1));
    const chosen = selector.select(new Set(['a', 'b']));
    expect(chosen).toBeDefined();
    expect(chosen!.breaker.state()).toBe('half-open');
  });
});

describe('jito sender: non-Error rejections', () => {
  it('wraps thrown strings into Errors', async () => {
    const impl = (async () => {
       
      throw 'string-boom';
    }) as unknown as typeof fetch;
    const sender = new JitoSender({ fetchImpl: impl });
    await expect(sender.sendTransaction('TX')).rejects.toThrow('string-boom');
  });

  it('handles tip floor responses with malformed bodies', async () => {
    const impl = (async () =>
      new Response('"not-an-array"', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const sender = new JitoSender({ fetchImpl: impl });
    expect(await sender.recommendedTipLamports()).toBe(1000n);
  });
});
