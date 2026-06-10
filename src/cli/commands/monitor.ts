import pc from 'picocolors';
import type { Shield } from '../../index.js';
import {
  CLEAR_SCREEN,
  collectMethodStats,
  renderHealthTable,
  renderMethodTable,
} from '../render.js';

export interface MonitorOptions {
  readonly intervalMs?: number;
  readonly methods?: boolean;
  /** Output stream (stdout by default; injectable for tests). */
  readonly write?: (text: string) => void;
  readonly signal?: AbortSignal;
}

export function renderMonitorFrame(shield: Shield, showMethods: boolean): string {
  const lines: string[] = [];
  lines.push(pc.bold(`solana-shield monitor — ${new Date().toISOString()}`));
  lines.push('');
  lines.push(renderHealthTable(shield.health.snapshots()));
  if (showMethods) {
    const stats = collectMethodStats(shield.metrics.snapshot());
    lines.push('');
    lines.push(pc.bold('Per-method breakdown'));
    lines.push(stats.length > 0 ? renderMethodTable(stats) : pc.dim('(no traffic yet)'));
  }
  lines.push('');
  lines.push(pc.dim('ctrl-c to quit'));
  return lines.join('\n');
}

/** Live monitor loop: redraw the health table every interval until aborted. */
export async function runMonitor(shield: Shield, options: MonitorOptions = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? 1000;
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  await new Promise<void>(resolve => {
    const draw = (): void => write(CLEAR_SCREEN + renderMonitorFrame(shield, options.methods ?? false) + '\n');
    draw();
    const timer = setInterval(draw, intervalMs);
    const stop = (): void => {
      clearInterval(timer);
      resolve();
    };
    options.signal?.addEventListener('abort', stop, { once: true });
  });
}
