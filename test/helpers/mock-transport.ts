import type { RpcTransport } from '../../src/transport/types.js';

export interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
  readonly payload: unknown;
}

export type MethodHandler = (params: unknown, callIndex: number) => unknown;

export interface MockTransport extends RpcTransport {
  readonly calls: readonly RecordedCall[];
  callsFor(method: string): readonly RecordedCall[];
}

export function okResponse(result: unknown, id: unknown = 1): unknown {
  return { jsonrpc: '2.0', id, result };
}

export function rpcErrorResponse(code: number, message: string, id: unknown = 1): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Scriptable transport: map JSON-RPC method names to handlers. A handler may
 * return a full response envelope, return a plain value (auto-wrapped in a
 * result envelope), or throw. Records every call for assertions.
 */
export function createMockTransport(
  handlers: Record<string, MethodHandler | unknown> = {},
): MockTransport {
  const calls: RecordedCall[] = [];
  const countsPerMethod = new Map<string, number>();

  const transport = (async (config: Readonly<{ payload: unknown; signal?: AbortSignal }>) => {
    config.signal?.throwIfAborted();
    const payload = config.payload as { method?: string; params?: unknown; id?: unknown };
    const method = payload?.method ?? 'unknown';
    calls.push({ method, params: payload?.params, payload: config.payload });
    const index = countsPerMethod.get(method) ?? 0;
    countsPerMethod.set(method, index + 1);

    const handler = handlers[method];
    if (handler === undefined) {
      throw new Error(`MockTransport: no handler for method "${method}"`);
    }
    const outcome = typeof handler === 'function' ? (handler as MethodHandler)(payload?.params, index) : handler;
    const resolved = outcome instanceof Promise ? await outcome : outcome;
    if (
      typeof resolved === 'object' &&
      resolved !== null &&
      ('result' in resolved || 'error' in resolved)
    ) {
      return resolved;
    }
    return okResponse(resolved, payload?.id);
  }) as MockTransport;

  Object.defineProperty(transport, 'calls', { get: () => [...calls] });
  (transport as { callsFor?: (m: string) => readonly RecordedCall[] }).callsFor = (m: string) =>
    calls.filter(c => c.method === m);
  return transport;
}

/** A transport that always succeeds with the given result. */
export function alwaysOk(result: unknown = 'ok'): RpcTransport {
  return (async config => {
    config.signal?.throwIfAborted();
    const id = (config.payload as { id?: unknown })?.id ?? 1;
    return okResponse(result, id);
  }) as RpcTransport;
}

/** A transport that always rejects with the given error factory. */
export function alwaysFail(makeError: () => Error): RpcTransport {
  return (async () => {
    throw makeError();
  }) as RpcTransport;
}
