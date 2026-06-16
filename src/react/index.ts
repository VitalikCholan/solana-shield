import type { Signature } from '@solana/kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CreateShieldOptions, Shield, ShieldConfig } from '../index.js';
import { createShield } from '../index.js';
import type { EndpointHealthSnapshot } from '../transport/index.js';
import type { ReliableTxHandle, TxConfirmedEvent, TxStatusEvent } from '../tx/index.js';

/**
 * React bindings for solana-shield. Thin wrappers over the framework-agnostic
 * core — they map the SDK's event streams and health snapshots into React state.
 * Available from the optional `solana-shield/react` subpath (peer dep: react).
 */

/**
 * Create a {@link Shield} for the component's lifetime and destroy it on unmount.
 *
 * The shield is created once (from the initial config); change endpoints by
 * remounting (e.g. a `key` prop) rather than mutating config in place.
 */
export function useShield(config: ShieldConfig, options?: CreateShieldOptions): Shield {
  const [shield] = useState(() => createShield(config, options));
  useEffect(() => () => shield.destroy(), [shield]);
  return shield;
}

export type SendStatus = TxStatusEvent['type'] | 'idle';

export interface UseSendReliablyResult {
  /** Start a reliable send; aborts any in-flight one first. Returns the handle. */
  send(input: Parameters<Shield['sendReliably']>[0]): ReliableTxHandle;
  /** Abort the in-flight send. */
  abort(): void;
  /** Reset back to the idle state. */
  reset(): void;
  /** The latest lifecycle phase (`idle` before the first send). */
  status: SendStatus;
  /** Every lifecycle event observed so far, in order. */
  events: readonly TxStatusEvent[];
  signature?: Signature;
  result?: TxConfirmedEvent;
  error?: unknown;
  isPending: boolean;
}

interface SendState {
  status: SendStatus;
  events: TxStatusEvent[];
  signature?: Signature;
  result?: TxConfirmedEvent;
  error?: unknown;
  isPending: boolean;
}

const IDLE: SendState = { status: 'idle', events: [], isPending: false };

/**
 * Drive a `sendReliably` transaction and expose its live status for UI:
 * `building → feeEstimated → signed → sent → confirmed` (or `failed`/`expired`),
 * plus `signature`, `result`, `error`, and `isPending`.
 */
export function useSendReliably(shield: Shield): UseSendReliablyResult {
  const [state, setState] = useState<SendState>(IDLE);
  const handleRef = useRef<ReliableTxHandle | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      handleRef.current?.abort();
    };
  }, []);

  const safeSet = useCallback((update: (prev: SendState) => SendState) => {
    if (mounted.current) setState(update);
  }, []);

  const send = useCallback(
    (input: Parameters<Shield['sendReliably']>[0]): ReliableTxHandle => {
      handleRef.current?.abort();
      setState({ status: 'building', events: [], isPending: true });
      const handle = shield.sendReliably(input);
      handleRef.current = handle;

      void (async () => {
        try {
          for await (const event of handle) {
            safeSet(prev => ({
              ...prev,
              status: event.type,
              events: [...prev.events, event],
              ...(event.type === 'signed' ? { signature: event.signature } : {}),
            }));
          }
        } catch {
          // the terminal outcome is read from handle.result below
        }
        try {
          const result = await handle.result;
          safeSet(prev => ({ ...prev, status: 'confirmed', result, isPending: false }));
        } catch (error) {
          safeSet(prev => ({ ...prev, error, isPending: false }));
        }
      })();

      return handle;
    },
    [shield, safeSet],
  );

  const abort = useCallback(() => handleRef.current?.abort(), []);
  const reset = useCallback(() => setState(IDLE), []);

  return { ...state, send, abort, reset };
}

/** Poll the resilient pool's per-endpoint health for live dashboards. */
export function useEndpointHealth(shield: Shield, intervalMs = 1000): readonly EndpointHealthSnapshot[] {
  const [snapshots, setSnapshots] = useState<readonly EndpointHealthSnapshot[]>(() =>
    shield.health.snapshots(),
  );
  useEffect(() => {
    const id = setInterval(() => setSnapshots(shield.health.snapshots()), intervalMs);
    return () => clearInterval(id);
  }, [shield, intervalMs]);
  return snapshots;
}
