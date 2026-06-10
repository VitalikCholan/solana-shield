import { describe, expect, it } from 'vitest';
import {
  deriveWsUrl,
  inferProvider,
  resolveEndpoints,
  resolveUrlOrMoniker,
} from '../../src/config.js';

describe('resolveUrlOrMoniker', () => {
  it('expands monikers', () => {
    expect(resolveUrlOrMoniker('devnet')).toBe('https://api.devnet.solana.com');
    expect(resolveUrlOrMoniker('MAINNET')).toBe('https://api.mainnet-beta.solana.com');
    expect(resolveUrlOrMoniker('localnet')).toBe('http://127.0.0.1:8899');
  });
  it('passes through full URLs', () => {
    expect(resolveUrlOrMoniker('https://rpc.example.com/key')).toBe('https://rpc.example.com/key');
  });
  it('rejects junk and non-http protocols', () => {
    expect(() => resolveUrlOrMoniker('not a url')).toThrow(/invalid endpoint/i);
    expect(() => resolveUrlOrMoniker('ftp://rpc.example.com')).toThrow(/http/);
  });
});

describe('deriveWsUrl', () => {
  it('maps https→wss and http→ws', () => {
    expect(deriveWsUrl('https://rpc.example.com/key')).toBe('wss://rpc.example.com/key');
    expect(deriveWsUrl('http://rpc.example.com')).toBe('ws://rpc.example.com/');
  });
  it('bumps the local validator port 8899→8900', () => {
    expect(deriveWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8900/');
  });
});

describe('inferProvider', () => {
  it.each([
    ['https://mainnet.helius-rpc.com/?api-key=x', 'helius'],
    ['https://example.solana-mainnet.quiknode.pro/abc/', 'quicknode'],
    ['https://my-org.rpcpool.com/token', 'triton'],
    ['https://api.mainnet-beta.solana.com', 'generic'],
  ])('%s → %s', (url, provider) => {
    expect(inferProvider(url)).toBe(provider);
  });
});

describe('resolveEndpoints', () => {
  it('resolves strings and config objects with defaults', () => {
    const [a, b] = resolveEndpoints([
      'devnet',
      { url: 'https://mainnet.helius-rpc.com/?api-key=x', weight: 3, rps: 10, label: 'helius' },
    ]);
    expect(a).toMatchObject({
      url: 'https://api.devnet.solana.com',
      wsUrl: 'wss://api.devnet.solana.com/',
      label: 'api.devnet.solana.com',
      weight: 1,
      provider: 'generic',
    });
    expect(b).toMatchObject({ label: 'helius', weight: 3, rps: 10, provider: 'helius' });
  });

  it('disambiguates duplicate labels', () => {
    const endpoints = resolveEndpoints(['devnet', 'devnet']);
    expect(endpoints.map(e => e.id)).toEqual(['api.devnet.solana.com', 'api.devnet.solana.com#2']);
  });

  it('respects explicit wsUrl and provider', () => {
    const [endpoint] = resolveEndpoints([
      { url: 'https://rpc.example.com', wsUrl: 'wss://ws.example.com', provider: 'triton' },
    ]);
    expect(endpoint).toMatchObject({ wsUrl: 'wss://ws.example.com', provider: 'triton' });
  });

  it('rejects an empty list', () => {
    expect(() => resolveEndpoints([])).toThrow(/at least one/i);
  });
});
