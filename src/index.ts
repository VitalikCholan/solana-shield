import type { Rpc, RpcSubscriptions, SolanaRpcApi, SolanaRpcSubscriptionsApi } from '@solana/kit';
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createSolanaRpcSubscriptions,
} from '@solana/kit';
import type { ResolvedEndpoint, ShieldConfig } from './config.js';
import { resolveEndpoints } from './config.js';
import { FeeOracle } from './fees/oracle.js';
import { createHeliusFeeSource } from './fees/sources/helius.js';
import { createNativeFeeSource } from './fees/sources/native.js';
import { createQuickNodeFeeSource } from './fees/sources/quicknode.js';
import { createTritonFeeSource } from './fees/sources/triton.js';
import type { FeeSource } from './fees/types.js';
import { JitoSender } from './jito/sender.js';
import { MetricsRegistry } from './telemetry/registry.js';
import type { HealthRegistry } from './transport/health.js';
import { createCoalescingMiddleware } from './transport/coalesce.js';
import { createHedgingMiddleware } from './transport/hedge.js';
import { startSlotProbe } from './transport/slot-probe.js';
import type { TransportMiddleware } from './transport/stack.js';
import { composeTransport, createResilientTransport } from './transport/stack.js';
import type { RpcTransport } from './transport/types.js';
import type { ReliableTxHandle, SendReliablyInput } from './tx/pipeline.js';
import { sendReliably as runSendReliably } from './tx/pipeline.js';

export interface Shield {
  /** Drop-in resilient RPC client (kit-typed). Use anywhere an `Rpc` is expected. */
  readonly rpc: Rpc<SolanaRpcApi>;
  /** Per-endpoint subscription clients (first = first configured endpoint). */
  readonly rpcSubscriptions: readonly RpcSubscriptions<SolanaRpcSubscriptionsApi>[];
  /** The raw resilient transport, for `createSolanaRpcFromTransport` or gill interop. */
  readonly transport: RpcTransport;
  readonly health: HealthRegistry;
  readonly metrics: MetricsRegistry;
  readonly fees: FeeOracle;
  readonly jito: JitoSender | undefined;
  readonly endpoints: readonly ResolvedEndpoint[];
  sendReliably(
    input: Omit<SendReliablyInput, 'feeLevel' | 'maxMicroLamportsPerCu'> &
      Partial<Pick<SendReliablyInput, 'feeLevel' | 'maxMicroLamportsPerCu'>>,
  ): ReliableTxHandle;
  destroy(): void;
}

export interface CreateShieldOptions {
  /** Override transport creation per endpoint (used by tests and chaos demos). */
  readonly transportFactory?: (endpoint: ResolvedEndpoint) => RpcTransport;
  /** Override subscription-client creation per endpoint. */
  readonly subscriptionsFactory?: (
    endpoint: ResolvedEndpoint,
  ) => RpcSubscriptions<SolanaRpcSubscriptionsApi>;
}

/**
 * Build the full solana-shield stack from one config object: a resilient
 * transport over every configured endpoint, a kit RPC on top of it, fee
 * oracle (provider-matched sources + native fallback), optional Jito routing,
 * health registry, metrics, and the `sendReliably` transaction pipeline.
 */
export function createShield(config: ShieldConfig, options: CreateShieldOptions = {}): Shield {
  const metrics = new MetricsRegistry();
  const endpoints = resolveEndpoints(config.endpoints);

  const transportFactory =
    options.transportFactory ??
    ((endpoint: ResolvedEndpoint) => createDefaultRpcTransport({ url: endpoint.url }) as RpcTransport);
  const rawTransports = new Map<string, RpcTransport>(
    endpoints.map(e => [e.id, transportFactory(e)]),
  );

  const resilient = createResilientTransport({
    endpoints: endpoints.map(e => ({
      id: e.id,
      url: e.url,
      wsUrl: e.wsUrl,
      label: e.label,
      weight: e.weight,
      ...(e.rps !== undefined ? { rps: e.rps } : {}),
      transport: rawTransports.get(e.id)!,
    })),
    metrics,
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.requestTimeoutMs !== undefined ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
    ...(config.breaker ? { breaker: config.breaker } : {}),
    ...(config.scoreFn ? { scoreFn: config.scoreFn } : {}),
  });

  const middlewares: TransportMiddleware[] = [];
  if (config.coalescing) middlewares.push(createCoalescingMiddleware());
  if (config.hedging?.enabled) {
    middlewares.push(
      createHedgingMiddleware({
        delayMs:
          config.hedging.delayMs ??
          (() => {
            // Derive from live p95 across endpoints; floor at 50ms.
            const p95s = resilient.health.snapshots().map(s => s.p95Ms).filter(v => v > 0);
            return Math.max(50, ...p95s);
          }),
      }),
    );
  }
  const transport = composeTransport(resilient.transport, ...middlewares);

  const rpc = createSolanaRpcFromTransport(transport as Parameters<typeof createSolanaRpcFromTransport>[0]);

  const subscriptionsFactory =
    options.subscriptionsFactory ?? ((endpoint: ResolvedEndpoint) => createSolanaRpcSubscriptions(endpoint.wsUrl));
  const rpcSubscriptions = endpoints.map(e => subscriptionsFactory(e));

  const fees = new FeeOracle(buildFeeSources(config, endpoints, rawTransports, rpc), {
    metrics,
    ...(config.fees?.budgetMs !== undefined ? { budgetMs: config.fees.budgetMs } : {}),
  });

  const jito = config.jito
    ? new JitoSender({
        ...(config.jito.regions ? { regions: config.jito.regions } : {}),
        ...(config.jito.authUuid ? { authUuid: config.jito.authUuid } : {}),
        metrics,
      })
    : undefined;

  const stopProbe =
    config.slotProbe?.enabled === false
      ? () => {}
      : startSlotProbe(resilient.health, {
          ...(config.slotProbe?.intervalMs !== undefined
            ? { intervalMs: config.slotProbe.intervalMs }
            : {}),
        });

  return {
    rpc,
    rpcSubscriptions,
    transport,
    health: resilient.health,
    metrics,
    fees,
    jito,
    endpoints,
    sendReliably(input) {
      return runSendReliably(
        {
          rpc,
          subscriptions: rpcSubscriptions,
          feeSource: fees,
          ...(jito ? { jito } : {}),
          metrics,
        },
        {
          feeLevel: config.fees?.level ?? 'medium',
          ...(config.fees?.maxMicroLamportsPerCu !== undefined
            ? { maxMicroLamportsPerCu: config.fees.maxMicroLamportsPerCu }
            : {}),
          ...input,
        },
      );
    },
    destroy() {
      stopProbe();
    },
  };
}

function buildFeeSources(
  config: ShieldConfig,
  endpoints: readonly ResolvedEndpoint[],
  rawTransports: ReadonlyMap<string, RpcTransport>,
  rpc: Rpc<SolanaRpcApi>,
): FeeSource[] {
  const wanted = config.fees?.sources;
  const sources: FeeSource[] = [];
  const providerFactories = {
    helius: createHeliusFeeSource,
    quicknode: createQuickNodeFeeSource,
    triton: createTritonFeeSource,
  } as const;

  for (const provider of ['helius', 'quicknode', 'triton'] as const) {
    if (wanted && !wanted.includes(provider)) continue;
    const endpoint = endpoints.find(e => e.provider === provider);
    if (!endpoint) continue;
    sources.push(providerFactories[provider](rawTransports.get(endpoint.id)!));
  }
  if (!wanted || wanted.includes('native')) {
    sources.push(createNativeFeeSource(rpc));
  }
  if (sources.length === 0) {
    // Whatever the config said, an oracle with zero sources can't exist —
    // native works everywhere and the pipeline's ceiling bounds the risk.
    sources.push(createNativeFeeSource(rpc));
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Re-exports: the full toolkit is reachable from the root import.
// ---------------------------------------------------------------------------

export type {
  FeeSourceName,
  ResolvedEndpoint,
  RpcProvider,
  ShieldConfig,
  ShieldEndpointConfig,
} from './config.js';
export { deriveWsUrl, inferProvider, resolveEndpoints, resolveUrlOrMoniker } from './config.js';

export * from './transport/index.js';
export * from './fees/index.js';
export * from './jito/index.js';
export * from './tx/index.js';
export * from './telemetry/index.js';
export { createChaosTransport, scenarios } from './chaos/index.js';
export type { ChaosStats, ChaosTransport, FaultPlan } from './chaos/index.js';
