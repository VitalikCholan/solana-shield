import { describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from '../../../src/telemetry/registry.js';

// Simulate @opentelemetry/api not being installed: the optional peer import
// must fail gracefully and leave the registry fully functional.
vi.mock('@opentelemetry/api', () => {
  throw new Error("Cannot find module '@opentelemetry/api'");
});

describe('enableOpenTelemetry without @opentelemetry/api', () => {
  it('returns a disabled no-op mirror', async () => {
    const { enableOpenTelemetry } = await import('../../../src/telemetry/otel.js');
    const registry = new MetricsRegistry();
    const mirror = await enableOpenTelemetry(registry);
    expect(mirror.enabled).toBe(false);
    expect(() => mirror.disable()).not.toThrow();
    registry.count('still.works');
    expect(registry.getCounter('still.works')).toBe(1);
  });
});
