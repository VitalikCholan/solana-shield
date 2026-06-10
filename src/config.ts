import type { JitoRegion } from './jito/sender.js';
import type { FeeLevel } from './fees/types.js';
import type { BreakerOptions } from './transport/circuit-breaker.js';
import type { ScoreFunction } from './transport/health.js';
import type { RetryPolicy } from './transport/retry.js';

export type RpcProvider = 'helius' | 'quicknode' | 'triton' | 'generic';

export interface ShieldEndpointConfig {
  /** Full RPC URL, or a moniker: 'mainnet' | 'devnet' | 'testnet' | 'localnet'. */
  readonly url: string;
  /** WebSocket URL; derived from `url` (http→ws) when omitted. */
  readonly wsUrl?: string;
  readonly label?: string;
  readonly weight?: number;
  /** Proactive requests-per-second cap (free-tier protection). */
  readonly rps?: number;
  /** Provider hint for provider-specific fee APIs; inferred from the URL when omitted. */
  readonly provider?: RpcProvider;
}

export type FeeSourceName = 'helius' | 'quicknode' | 'triton' | 'native';

export interface ShieldConfig {
  readonly endpoints: ReadonlyArray<string | ShieldEndpointConfig>;
  /** Enable Jito MEV-protected routing by configuring it (omit = RPC-only). */
  readonly jito?: {
    readonly regions?: readonly JitoRegion[];
    readonly authUuid?: string;
  };
  readonly fees?: {
    /** Which sources to use; defaults to provider-matched sources + native fallback. */
    readonly sources?: readonly FeeSourceName[];
    readonly level?: FeeLevel;
    readonly maxMicroLamportsPerCu?: bigint;
    readonly budgetMs?: number;
  };
  readonly retry?: Partial<RetryPolicy>;
  /** Hedged reads: fire a duplicate read if the first hasn't settled in delayMs. */
  readonly hedging?: { readonly enabled?: boolean; readonly delayMs?: number };
  /** Deduplicate identical in-flight reads. */
  readonly coalescing?: boolean;
  readonly requestTimeoutMs?: number;
  readonly breaker?: BreakerOptions;
  readonly scoreFn?: ScoreFunction;
  readonly slotProbe?: { readonly enabled?: boolean; readonly intervalMs?: number };
}

export interface ResolvedEndpoint {
  readonly id: string;
  readonly url: string;
  readonly wsUrl: string;
  readonly label: string;
  readonly weight: number;
  readonly rps: number | undefined;
  readonly provider: RpcProvider;
}

const MONIKERS: Record<string, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
  localhost: 'http://127.0.0.1:8899',
};

export function resolveUrlOrMoniker(urlOrMoniker: string): string {
  const moniker = MONIKERS[urlOrMoniker.toLowerCase()];
  if (moniker) return moniker;
  let parsed: URL;
  try {
    parsed = new URL(urlOrMoniker);
  } catch {
    throw new Error(
      `Invalid endpoint "${urlOrMoniker}": expected a URL or one of ${Object.keys(MONIKERS).join(', ')}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Invalid endpoint "${urlOrMoniker}": protocol must be http(s)`);
  }
  return urlOrMoniker;
}

export function deriveWsUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  // Public Solana RPC websockets listen on port 8900 when the HTTP port is 8899.
  if (url.port === '8899') url.port = '8900';
  return url.toString();
}

export function inferProvider(url: string): RpcProvider {
  const host = new URL(url).hostname.toLowerCase();
  if (host.includes('helius')) return 'helius';
  if (host.includes('quiknode') || host.includes('quicknode')) return 'quicknode';
  if (host.includes('rpcpool') || host.includes('triton')) return 'triton';
  return 'generic';
}

export function resolveEndpoints(
  endpoints: ReadonlyArray<string | ShieldEndpointConfig>,
): ResolvedEndpoint[] {
  if (endpoints.length === 0) {
    throw new Error('ShieldConfig.endpoints must contain at least one endpoint');
  }
  const seen = new Set<string>();
  return endpoints.map((entry, index) => {
    const config: ShieldEndpointConfig = typeof entry === 'string' ? { url: entry } : entry;
    const url = resolveUrlOrMoniker(config.url);
    const label = config.label ?? defaultLabel(url, index);
    let id = label;
    for (let n = 2; seen.has(id); n++) id = `${label}#${n}`;
    seen.add(id);
    return {
      id,
      url,
      wsUrl: config.wsUrl ?? deriveWsUrl(url),
      label: id,
      weight: config.weight ?? 1,
      rps: config.rps,
      provider: config.provider ?? inferProvider(url),
    };
  });
}

function defaultLabel(url: string, index: number): string {
  try {
    return new URL(url).hostname;
  } catch {
    return `endpoint-${index}`;
  }
}
