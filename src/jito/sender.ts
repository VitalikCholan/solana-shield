import { sleep } from '../internal/async.js';
import type { MetricsRegistry } from '../telemetry/registry.js';
import { classifyHttpStatus } from '../transport/classify.js';
import { TokenBucket } from '../transport/rate-limit.js';
import type { JitoSenderLike } from './types.js';

export type JitoRegion =
  | 'mainnet' // global, routed by Jito
  | 'amsterdam'
  | 'dublin'
  | 'frankfurt'
  | 'london'
  | 'ny'
  | 'slc'
  | 'singapore'
  | 'tokyo';

/**
 * The canonical 8 Jito tip accounts. Stable per Jito docs; used as a fallback
 * when the `getTipAccounts` call is unavailable.
 */
export const JITO_TIP_ACCOUNTS: readonly string[] = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

export const JITO_MIN_TIP_LAMPORTS = 1000n;
const DEFAULT_TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';

export interface JitoSenderOptions {
  /** Block-engine regions tried in order (default: the global 'mainnet' endpoint). */
  readonly regions?: readonly JitoRegion[];
  /** Optional Jito auth UUID (sent as `x-jito-auth`). */
  readonly authUuid?: string;
  /** Per-region request timeout (default 2s). */
  readonly requestTimeoutMs?: number;
  readonly tipFloorUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly metrics?: MetricsRegistry;
  readonly now?: () => number;
  readonly random?: () => number;
}

function regionBaseUrl(region: JitoRegion): string {
  return region === 'mainnet'
    ? 'https://mainnet.block-engine.jito.wtf'
    : `https://${region}.mainnet.block-engine.jito.wtf`;
}

interface JsonRpcEnvelope<T> {
  readonly result?: T;
  readonly error?: { readonly code: number; readonly message?: string };
}

/**
 * Anti-frontrun transaction submission via Jito block engines.
 *
 * - Tries regions in order with a per-region timeout and 1 rps token bucket
 *   (Jito's documented default rate limit), so a saturated region rotates
 *   instead of provoking 429s.
 * - Tip accounts come from `getTipAccounts` (cached), falling back to the
 *   canonical constants.
 * - The recommended tip tracks the live tip-floor feed (50th percentile of
 *   recently landed tips, 10s cache), floored at 1000 lamports.
 */
export class JitoSender implements JitoSenderLike {
  readonly label: string;
  private readonly regions: readonly JitoRegion[];
  private readonly buckets: Map<JitoRegion, TokenBucket>;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly tipFloorUrl: string;
  private readonly now: () => number;
  private readonly random: () => number;
  private tipAccountsCache: readonly string[] | undefined;
  private tipFloorCache: { lamports: bigint; expiresAt: number } | undefined;

  constructor(private readonly options: JitoSenderOptions = {}) {
    this.regions = options.regions && options.regions.length > 0 ? options.regions : ['mainnet'];
    this.label = `jito:${this.regions.join(',')}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2000;
    this.tipFloorUrl = options.tipFloorUrl ?? DEFAULT_TIP_FLOOR_URL;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.buckets = new Map(this.regions.map(r => [r, new TokenBucket(1, 1, this.now)]));
  }

  async sendTransaction(wireTransactionBase64: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
    await this.callRegions<string>('/api/v1/transactions', {
      id: 'shield-jito-send',
      jsonrpc: '2.0',
      method: 'sendTransaction',
      params: [wireTransactionBase64, { encoding: 'base64' }],
    }, opts.signal);
    this.options.metrics?.count('solana_shield.jito.send.count', { outcome: 'success' });
  }

  /** Submit an atomic bundle (up to 5 base64 transactions). Returns the bundle id. */
  async sendBundle(wireTransactionsBase64: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<string> {
    if (wireTransactionsBase64.length === 0 || wireTransactionsBase64.length > 5) {
      throw new Error('Jito bundles must contain 1–5 transactions');
    }
    return await this.callRegions<string>('/api/v1/bundles', {
      id: 'shield-jito-bundle',
      jsonrpc: '2.0',
      method: 'sendBundle',
      params: [wireTransactionsBase64, { encoding: 'base64' }],
    }, opts.signal);
  }

  async getBundleStatuses(bundleIds: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<unknown> {
    return await this.callRegions<unknown>('/api/v1/bundles', {
      id: 'shield-jito-bundle-status',
      jsonrpc: '2.0',
      method: 'getBundleStatuses',
      params: [bundleIds],
    }, opts.signal);
  }

  async getTipAccounts(opts: { signal?: AbortSignal } = {}): Promise<readonly string[]> {
    if (this.tipAccountsCache) return this.tipAccountsCache;
    try {
      const accounts = await this.callRegions<string[]>('/api/v1/bundles', {
        id: 'shield-jito-tip-accounts',
        jsonrpc: '2.0',
        method: 'getTipAccounts',
        params: [],
      }, opts.signal);
      if (Array.isArray(accounts) && accounts.length > 0) {
        this.tipAccountsCache = accounts;
        return accounts;
      }
    } catch {
      // fall through to the canonical constants
    }
    this.tipAccountsCache = JITO_TIP_ACCOUNTS;
    return JITO_TIP_ACCOUNTS;
  }

  async randomTipAccount(opts: { signal?: AbortSignal } = {}): Promise<string> {
    const accounts = await this.getTipAccounts(opts);
    return accounts[Math.floor(this.random() * accounts.length)] ?? JITO_TIP_ACCOUNTS[0]!;
  }

  async recommendedTipLamports(opts: { signal?: AbortSignal } = {}): Promise<bigint> {
    if (this.tipFloorCache && this.tipFloorCache.expiresAt > this.now()) {
      return this.tipFloorCache.lamports;
    }
    let lamports = JITO_MIN_TIP_LAMPORTS;
    try {
      const response = await this.fetchWithTimeout(this.tipFloorUrl, { method: 'GET' }, opts.signal);
      if (response.ok) {
        const body = (await response.json()) as Array<Record<string, number>>;
        const p50Sol = body?.[0]?.['landed_tips_50th_percentile'];
        if (typeof p50Sol === 'number' && Number.isFinite(p50Sol) && p50Sol > 0) {
          const fromFloor = BigInt(Math.round(p50Sol * 1_000_000_000));
          lamports = fromFloor > JITO_MIN_TIP_LAMPORTS ? fromFloor : JITO_MIN_TIP_LAMPORTS;
        }
      }
    } catch {
      // tip floor is advisory; the minimum tip always works in calm conditions
    }
    this.tipFloorCache = { lamports, expiresAt: this.now() + 10_000 };
    this.options.metrics?.gauge('solana_shield.jito.tip_lamports', Number(lamports));
    return lamports;
  }

  // -------------------------------------------------------------------------

  private async callRegions<T>(path: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    let lastError: unknown = new Error('No Jito regions configured');
    for (const region of this.regions) {
      signal?.throwIfAborted();
      const bucket = this.buckets.get(region)!;
      if (!bucket.tryRemove()) {
        const waitMs = bucket.msUntilAvailable();
        // Don't stall a time-critical send for a saturated region if another
        // region could take it now; only wait when this is the only region.
        if (this.regions.length > 1) {
          lastError = new Error(`jito region ${region} rate-capped`);
          continue;
        }
        await sleep(waitMs, signal);
        bucket.tryRemove();
      }
      try {
        const response = await this.fetchWithTimeout(
          `${regionBaseUrl(region)}${path}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(this.options.authUuid ? { 'x-jito-auth': this.options.authUuid } : {}),
            },
            body: JSON.stringify(payload),
          },
          signal,
        );
        if (!response.ok) {
          const failure = classifyHttpStatus(response.status, undefined);
          this.options.metrics?.count('solana_shield.jito.send.count', {
            outcome: 'failure',
            region,
            status: String(response.status),
          });
          lastError = new Error(`jito ${region}: ${failure.message}`);
          continue;
        }
        const body = (await response.json()) as JsonRpcEnvelope<T>;
        if (body.error) {
          lastError = new Error(`jito ${region}: JSON-RPC ${body.error.code}: ${body.error.message ?? ''}`);
          continue;
        }
        return body.result as T;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('jito request timed out')), this.requestTimeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}
