import type { Signature } from '@solana/kit';

/**
 * The transaction's blockhash lifetime ended without a confirmation. The
 * transaction may be safely rebuilt and re-signed — it can no longer land.
 */
export class TxExpiredError extends Error {
  override readonly name = 'TxExpiredError';
  constructor(
    readonly signature: Signature,
    readonly lastValidBlockHeight: bigint,
    readonly blockHeight: bigint,
  ) {
    super(
      `Transaction ${signature} expired: block height ${blockHeight} passed lastValidBlockHeight ${lastValidBlockHeight}`,
    );
  }
}

/** The transaction landed on chain but failed during execution. */
export class TxFailedError extends Error {
  override readonly name = 'TxFailedError';
  constructor(
    readonly signature: Signature | undefined,
    readonly error: unknown,
  ) {
    super(`Transaction ${signature ?? '(unsigned)'} failed: ${stringifyTxError(error)}`);
  }
}

/**
 * A pre-broadcast simulation revealed the transaction would fail. Caught
 * cheaply (one simulate call) before wasting a broadcast + fee; carries a
 * decoded, human-readable reason plus the raw error and program logs.
 */
export class TxSimulationError extends Error {
  override readonly name = 'TxSimulationError';
  constructor(
    readonly simulationError: unknown,
    readonly logs: readonly string[] = [],
  ) {
    super(`Transaction would fail (preflight): ${decodeSimulationError(simulationError, logs)}`);
  }
}

export function stringifyTxError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    return String(error);
  }
}

/** CamelCase / PascalCase → spaced lower-case, e.g. `InsufficientFundsForRent`. */
function humanize(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
}

/** Pull the most useful human reason out of program logs (Anchor / msg!). */
function reasonFromLogs(logs: readonly string[]): string | undefined {
  for (const line of logs) {
    const anchor = line.match(/Error Message: (.+?)\.?$/);
    if (anchor?.[1]) return anchor[1].trim();
  }
  for (const line of logs) {
    const m = line.match(/Program log: (?:Error: )?(.+)/);
    if (m?.[1] && !/instruction|invoke|consumed|success|^log$/i.test(m[1])) return m[1].trim();
  }
  return undefined;
}

function decodeInstructionError(detail: unknown, logs: readonly string[]): string {
  let base: string;
  if (typeof detail === 'string') {
    base = humanize(detail);
  } else if (detail && typeof detail === 'object' && 'Custom' in detail) {
    const code = Number((detail as { Custom: number }).Custom);
    base = `custom program error ${code} (0x${code.toString(16)})`;
  } else {
    base = stringifyTxError(detail);
  }
  const reason = reasonFromLogs(logs);
  return reason ? `${base} — ${reason}` : base;
}

/**
 * Decode a Solana `TransactionError` into a readable string. Handles the common
 * shapes: plain strings (`"AccountNotFound"`), `{ InstructionError: [i, …] }`
 * (with `{ Custom: n }` program codes), and other single-key variants.
 */
export function decodeSimulationError(error: unknown, logs: readonly string[] = []): string {
  if (typeof error === 'string') return humanize(error);
  if (error && typeof error === 'object') {
    if ('InstructionError' in error) {
      const [index, detail] = (error as { InstructionError: [number, unknown] }).InstructionError;
      return `instruction #${index} failed: ${decodeInstructionError(detail, logs)}`;
    }
    const key = Object.keys(error)[0];
    if (key) return humanize(key);
  }
  return stringifyTxError(error);
}
