import type { Commitment, Signature } from '@solana/kit';
import type { ClassifiedFailure } from '../transport/types.js';

export type SendRoute = 'jito' | 'rpc';

export type TxStatusEvent =
  | { readonly type: 'building' }
  | {
      readonly type: 'feeEstimated';
      readonly microLamportsPerCu: bigint;
      readonly computeUnitLimit: number;
      readonly source: string;
    }
  | { readonly type: 'signed'; readonly signature: Signature }
  | {
      readonly type: 'sent';
      readonly via: SendRoute;
      readonly endpoint: string;
      readonly attempt: number;
    }
  | {
      readonly type: 'jitoFallback';
      readonly reason: 'signerCannotExportBytes' | 'jitoUnavailable' | 'jitoSendFailed';
      readonly detail?: string | ClassifiedFailure;
    }
  | { readonly type: 'resent'; readonly via: SendRoute; readonly attempt: number }
  | {
      readonly type: 'confirmed';
      readonly signature: Signature;
      readonly commitment: Commitment;
      readonly slot: bigint;
      readonly confirmedVia: 'ws' | 'poll';
    }
  | {
      readonly type: 'expired';
      readonly signature: Signature;
      readonly lastValidBlockHeight: bigint;
      readonly blockHeight: bigint;
    }
  | { readonly type: 'failed'; readonly signature?: Signature; readonly error: unknown };

export type TxConfirmedEvent = Extract<TxStatusEvent, { type: 'confirmed' }>;

/**
 * Multicast async event stream with full replay: every iterator obtained from
 * `[Symbol.asyncIterator]()` observes all events from the beginning, so
 * consumers can attach after the transaction pipeline has already started.
 */
export class EventStream<T> implements AsyncIterable<T> {
  private readonly history: T[] = [];
  private done = false;
  private signal = deferred();

  push(event: T): void {
    if (this.done) return;
    this.history.push(event);
    this.wake();
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    this.wake();
  }

  get events(): readonly T[] {
    return this.history;
  }

  private wake(): void {
    const previous = this.signal;
    this.signal = deferred();
    previous.resolve();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0;
    return {
      next: async (): Promise<IteratorResult<T>> => {
        for (;;) {
          if (index < this.history.length) {
            return { value: this.history[index++] as T, done: false };
          }
          if (this.done) return { value: undefined, done: true };
          await this.signal.promise;
        }
      },
    };
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}
