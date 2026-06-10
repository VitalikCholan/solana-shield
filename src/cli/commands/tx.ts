import pc from 'picocolors';
import type { Signature } from '@solana/kit';
import type { Shield } from '../../index.js';
import { sleep } from '../../internal/async.js';
import { stringifyTxError } from '../../tx/errors.js';
import { toJson } from '../render.js';

export interface TxStatusSummary {
  readonly signature: string;
  readonly found: boolean;
  readonly confirmationStatus?: string;
  readonly slot?: bigint;
  readonly err?: unknown;
  readonly feeLamports?: bigint;
  readonly computeUnitsConsumed?: bigint;
  readonly blockTime?: bigint;
}

export async function fetchTxStatus(shield: Shield, signature: string): Promise<TxStatusSummary> {
  const statuses = await shield.rpc
    .getSignatureStatuses([signature as Signature], { searchTransactionHistory: true })
    .send();
  const status = statuses.value[0];
  if (!status) return { signature, found: false };

  const summary: TxStatusSummary = {
    signature,
    found: true,
    ...(status.confirmationStatus ? { confirmationStatus: status.confirmationStatus } : {}),
    slot: status.slot,
    err: status.err,
  };
  try {
    const transaction = await shield.rpc
      .getTransaction(signature as Signature, {
        commitment: 'confirmed',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      })
      .send();
    if (transaction) {
      return {
        ...summary,
        ...(transaction.meta?.fee !== undefined ? { feeLamports: transaction.meta.fee } : {}),
        ...(transaction.meta?.computeUnitsConsumed !== undefined
          ? { computeUnitsConsumed: transaction.meta.computeUnitsConsumed }
          : {}),
        ...(transaction.blockTime != null ? { blockTime: transaction.blockTime } : {}),
      };
    }
  } catch {
    // status alone is still useful (e.g. node without tx history)
  }
  return summary;
}

export function renderTxSummary(summary: TxStatusSummary, json: boolean): string {
  if (json) return toJson(summary);
  if (!summary.found) {
    return `${pc.red('not found')} — signature unknown to the cluster (dropped, expired, or never sent)`;
  }
  const lines = [
    `signature : ${summary.signature}`,
    `status    : ${summary.err ? pc.red(`failed (${stringifyTxError(summary.err)})`) : pc.green(summary.confirmationStatus ?? 'processed')}`,
    `slot      : ${summary.slot}`,
  ];
  if (summary.feeLamports !== undefined) lines.push(`fee       : ${summary.feeLamports} lamports`);
  if (summary.computeUnitsConsumed !== undefined) lines.push(`compute   : ${summary.computeUnitsConsumed} CU`);
  if (summary.blockTime !== undefined)
    lines.push(`block time: ${new Date(Number(summary.blockTime) * 1000).toISOString()}`);
  return lines.join('\n');
}

/** Watch a signature until it finalizes (or the signal aborts). */
export async function watchTx(
  shield: Shield,
  signature: string,
  options: { intervalMs?: number; write?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<TxStatusSummary> {
  const write = options.write ?? ((line: string) => process.stdout.write(line + '\n'));
  let last = '';
  for (;;) {
    const summary = await fetchTxStatus(shield, signature);
    const stamp = `${summary.confirmationStatus ?? 'unknown'}${summary.err ? ' (failed)' : ''}`;
    if (stamp !== last) {
      write(`[${new Date().toISOString()}] ${stamp}`);
      last = stamp;
    }
    if (summary.confirmationStatus === 'finalized' || summary.err) return summary;
    await sleep(options.intervalMs ?? 2000, options.signal);
  }
}
