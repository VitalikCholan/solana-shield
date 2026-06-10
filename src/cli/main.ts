import { Command } from 'commander';
import type { FeeLevel } from '../fees/types.js';
import { createShield } from '../index.js';
import type { Shield } from '../index.js';
import { loadCliConfig } from './config.js';
import { renderDoctorReport, runDoctor } from './commands/doctor.js';
import { renderFeesReport, runFees } from './commands/fees.js';
import { runMonitor } from './commands/monitor.js';
import { fetchTxStatus, renderTxSummary, watchTx } from './commands/tx.js';

const program = new Command();

program
  .name('solana-shield')
  .description('RPC health diagnostics and transaction monitoring for Solana, powered by solana-shield')
  .option('-c, --config <path>', 'path to a solana-shield.config.json')
  .option('-e, --endpoints <urls>', 'comma-separated RPC endpoint URLs or monikers')
  .version('0.1.0');

function buildShield(options: { slotProbeIntervalMs?: number; slotProbe?: boolean }): Shield {
  const globals = program.opts<{ config?: string; endpoints?: string }>();
  const config = loadCliConfig(globals);
  return createShield({
    ...config,
    slotProbe: {
      enabled: options.slotProbe ?? true,
      ...(options.slotProbeIntervalMs !== undefined ? { intervalMs: options.slotProbeIntervalMs } : {}),
    },
  });
}

function onSigint(): AbortSignal {
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  return controller.signal;
}

program
  .command('doctor')
  .description('one-shot diagnostics: reachability, versions, slot agreement, WS, fee sources, Jito')
  .option('--json', 'machine-readable output', false)
  .option('--no-ws-check', 'skip WebSocket connectivity checks')
  .action(async (options: { json: boolean; wsCheck: boolean }) => {
    const shield = buildShield({ slotProbe: false });
    try {
      const report = await runDoctor(shield, { wsCheck: options.wsCheck });
      console.log(renderDoctorReport(report, options.json));
      process.exitCode = report.healthy ? 0 : 1;
    } finally {
      shield.destroy();
    }
  });

program
  .command('monitor')
  .description('live endpoint health table')
  .option('-i, --interval <ms>', 'refresh interval', '1000')
  .option('--methods', 'show per-method latency/success breakdown', false)
  .action(async (options: { interval: string; methods: boolean }) => {
    const shield = buildShield({ slotProbeIntervalMs: 2000 });
    try {
      await runMonitor(shield, {
        intervalMs: Number(options.interval),
        methods: options.methods,
        signal: onSigint(),
      });
    } finally {
      shield.destroy();
    }
  });

program
  .command('tx')
  .description('inspect a transaction signature (status, fee, compute units)')
  .argument('<signature>', 'base58 transaction signature')
  .option('--watch', 'poll until finalized', false)
  .option('--json', 'machine-readable output', false)
  .action(async (signature: string, options: { watch: boolean; json: boolean }) => {
    const shield = buildShield({ slotProbe: false });
    try {
      const summary = options.watch
        ? await watchTx(shield, signature, { signal: onSigint() })
        : await fetchTxStatus(shield, signature);
      console.log(renderTxSummary(summary, options.json));
      process.exitCode = summary.found && !summary.err ? 0 : 1;
    } finally {
      shield.destroy();
    }
  });

program
  .command('fees')
  .description('compare priority fee estimates across configured sources')
  .option('-a, --accounts <addresses>', 'comma-separated writable account addresses')
  .option('-l, --level <level>', 'low | medium | high | veryHigh', 'medium')
  .option('--json', 'machine-readable output', false)
  .action(async (options: { accounts?: string; level: string; json: boolean }) => {
    const shield = buildShield({ slotProbe: false });
    try {
      const report = await runFees(shield, {
        ...(options.accounts ? { accounts: options.accounts.split(',').map(s => s.trim()) } : {}),
        level: options.level as FeeLevel,
      });
      console.log(renderFeesReport(report, options.json));
    } finally {
      shield.destroy();
    }
  });

await program.parseAsync(process.argv);
