import pc from 'picocolors';
import type { Shield } from '../../index.js';
import type { FeeLevel } from '../../fees/types.js';
import { renderTable, toJson } from '../render.js';

export interface FeesReport {
  readonly level: FeeLevel;
  readonly sources: ReadonlyArray<{ source: string; value?: bigint; error?: string }>;
  readonly chosen?: bigint;
  readonly jitoTipFloorLamports?: bigint;
}

export async function runFees(
  shield: Shield,
  options: { accounts?: readonly string[]; level?: FeeLevel } = {},
): Promise<FeesReport> {
  const level = options.level ?? 'medium';
  const request = { writableAddresses: options.accounts ?? [], level };
  const sources = await shield.fees.compare(request);
  let chosen: bigint | undefined;
  try {
    chosen = await shield.fees.estimate(request, {});
  } catch {
    // every source failed; report stays useful
  }
  let jitoTipFloorLamports: bigint | undefined;
  if (shield.jito) {
    try {
      jitoTipFloorLamports = await shield.jito.recommendedTipLamports();
    } catch {
      // optional
    }
  }
  return {
    level,
    sources,
    ...(chosen !== undefined ? { chosen } : {}),
    ...(jitoTipFloorLamports !== undefined ? { jitoTipFloorLamports } : {}),
  };
}

export function renderFeesReport(report: FeesReport, json: boolean): string {
  if (json) return toJson(report);
  const lines: string[] = [];
  lines.push(pc.bold(`Priority fee estimates (level: ${report.level})`));
  lines.push(
    renderTable(
      ['SOURCE', 'µLAMPORTS/CU', 'ERROR'],
      report.sources.map(s => [
        s.source,
        s.value !== undefined ? s.value.toString() : '-',
        s.error ? s.error.slice(0, 60) : '-',
      ]),
    ),
  );
  if (report.chosen !== undefined) {
    lines.push('');
    lines.push(`chosen (max of sources): ${pc.bold(report.chosen.toString())} µlamports/CU`);
  }
  if (report.jitoTipFloorLamports !== undefined) {
    lines.push(`jito tip floor (p50)   : ${pc.bold(report.jitoTipFloorLamports.toString())} lamports`);
  }
  return lines.join('\n');
}
