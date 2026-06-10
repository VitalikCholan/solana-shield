import { afterEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../../../src/chaos/prng.js';
import {
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_ACCOUNTS,
  JitoSender,
} from '../../../src/jito/sender.js';

interface FakeResponse {
  status?: number;
  body?: unknown;
}

function fakeFetch(handler: (url: string, init: RequestInit) => FakeResponse | Promise<FakeResponse>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const res = await handler(String(url), init ?? {});
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

const okSend: FakeResponse = { body: { jsonrpc: '2.0', id: 1, result: 'sig' } };

afterEach(() => {
  vi.useRealTimers();
});

describe('JitoSender.sendTransaction', () => {
  it('posts base64 transactions to the block-engine transactions endpoint', async () => {
    const { impl, calls } = fakeFetch(() => okSend);
    const sender = new JitoSender({ fetchImpl: impl, authUuid: 'my-uuid' });
    await sender.sendTransaction('BASE64TX');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://mainnet.block-engine.jito.wtf/api/v1/transactions');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['x-jito-auth']).toBe('my-uuid');
    const body = JSON.parse(String(calls[0]!.init.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe('sendTransaction');
    expect(body.params).toEqual(['BASE64TX', { encoding: 'base64' }]);
  });

  it('fails over to the next region on 429', async () => {
    const { impl, calls } = fakeFetch(url =>
      url.includes('frankfurt') ? { status: 429 } : okSend,
    );
    const sender = new JitoSender({ fetchImpl: impl, regions: ['frankfurt', 'amsterdam'] });
    await sender.sendTransaction('TX');
    expect(calls.map(c => new URL(c.url).hostname)).toEqual([
      'frankfurt.mainnet.block-engine.jito.wtf',
      'amsterdam.mainnet.block-engine.jito.wtf',
    ]);
  });

  it('fails over on JSON-RPC errors and throws the last error when all regions fail', async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'rate limited' } },
    }));
    const sender = new JitoSender({ fetchImpl: impl, regions: ['ny', 'tokyo'] });
    await expect(sender.sendTransaction('TX')).rejects.toThrow(/jito tokyo.*rate limited/);
    expect(calls).toHaveLength(2);
  });

  it('enforces the 1 rps bucket for a single region by waiting', async () => {
    vi.useFakeTimers();
    const { impl, calls } = fakeFetch(() => okSend);
    const sender = new JitoSender({ fetchImpl: impl });
    await sender.sendTransaction('TX1');
    let done = false;
    const second = sender.sendTransaction('TX2').then(() => (done = true));
    await vi.advanceTimersByTimeAsync(500);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await second;
    expect(calls).toHaveLength(2);
  });

  it('skips a rate-capped region instead of stalling when others exist', async () => {
    const { impl, calls } = fakeFetch(() => okSend);
    const sender = new JitoSender({ fetchImpl: impl, regions: ['frankfurt', 'amsterdam'] });
    await sender.sendTransaction('TX1'); // consumes frankfurt's token
    await sender.sendTransaction('TX2'); // frankfurt capped → amsterdam immediately
    expect(calls.map(c => new URL(c.url).hostname)).toEqual([
      'frankfurt.mainnet.block-engine.jito.wtf',
      'amsterdam.mainnet.block-engine.jito.wtf',
    ]);
  });

  it('respects caller aborts', async () => {
    const { impl } = fakeFetch(() => okSend);
    const sender = new JitoSender({ fetchImpl: impl });
    const controller = new AbortController();
    controller.abort();
    await expect(sender.sendTransaction('TX', { signal: controller.signal })).rejects.toThrow();
  });
});

describe('JitoSender bundles', () => {
  it('sends bundles and returns the bundle id', async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, result: 'bundle-id-1' } }));
    const sender = new JitoSender({ fetchImpl: impl });
    const id = await sender.sendBundle(['TX1', 'TX2']);
    expect(id).toBe('bundle-id-1');
    expect(calls[0]!.url).toBe('https://mainnet.block-engine.jito.wtf/api/v1/bundles');
    const body = JSON.parse(String(calls[0]!.init.body)) as { method: string };
    expect(body.method).toBe('sendBundle');
  });

  it('rejects bundles outside the 1–5 transaction range', async () => {
    const { impl } = fakeFetch(() => okSend);
    const sender = new JitoSender({ fetchImpl: impl });
    await expect(sender.sendBundle([])).rejects.toThrow(/1–5/);
    await expect(sender.sendBundle(['1', '2', '3', '4', '5', '6'])).rejects.toThrow(/1–5/);
  });

  it('queries bundle statuses', async () => {
    const { impl, calls } = fakeFetch(() => ({
      body: { jsonrpc: '2.0', id: 1, result: { value: [{ bundle_id: 'b1', status: 'Landed' }] } },
    }));
    const sender = new JitoSender({ fetchImpl: impl });
    const statuses = await sender.getBundleStatuses(['b1']);
    expect(statuses).toMatchObject({ value: [{ status: 'Landed' }] });
    const body = JSON.parse(String(calls[0]!.init.body)) as { method: string; params: unknown[] };
    expect(body.method).toBe('getBundleStatuses');
    expect(body.params).toEqual([['b1']]);
  });
});

describe('JitoSender tips', () => {
  it('fetches and caches tip accounts from the block engine', async () => {
    const accounts = ['TipAcc1', 'TipAcc2'];
    const { impl, calls } = fakeFetch(() => ({ body: { jsonrpc: '2.0', id: 1, result: accounts } }));
    const sender = new JitoSender({ fetchImpl: impl });
    expect(await sender.getTipAccounts()).toEqual(accounts);
    expect(await sender.getTipAccounts()).toEqual(accounts);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the canonical tip accounts when the call fails', async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const sender = new JitoSender({ fetchImpl: impl });
    expect(await sender.getTipAccounts()).toEqual(JITO_TIP_ACCOUNTS);
  });

  it('picks a deterministic random tip account with an injected PRNG', async () => {
    const { impl } = fakeFetch(() => ({ status: 500 }));
    const sender = new JitoSender({ fetchImpl: impl, random: mulberry32(1) });
    const account = await sender.randomTipAccount();
    expect(JITO_TIP_ACCOUNTS).toContain(account);
  });

  it('converts the tip floor p50 from SOL to lamports', async () => {
    const { impl } = fakeFetch(url =>
      url.includes('tip_floor')
        ? { body: [{ landed_tips_50th_percentile: 0.00002 }] }
        : { status: 500 },
    );
    const sender = new JitoSender({ fetchImpl: impl });
    expect(await sender.recommendedTipLamports()).toBe(20_000n);
  });

  it('floors the tip at the 1000-lamport minimum', async () => {
    const { impl } = fakeFetch(() => ({ body: [{ landed_tips_50th_percentile: 0.0000001 }] }));
    const sender = new JitoSender({ fetchImpl: impl });
    expect(await sender.recommendedTipLamports()).toBe(JITO_MIN_TIP_LAMPORTS);
  });

  it('uses the minimum when the tip-floor feed is down, and caches for 10s', async () => {
    let time = 0;
    const { impl, calls } = fakeFetch(() => ({ status: 503 }));
    const sender = new JitoSender({ fetchImpl: impl, now: () => time });
    expect(await sender.recommendedTipLamports()).toBe(JITO_MIN_TIP_LAMPORTS);
    await sender.recommendedTipLamports();
    expect(calls).toHaveLength(1);
    time = 10_001;
    await sender.recommendedTipLamports();
    expect(calls).toHaveLength(2);
  });
});
