import pc from 'picocolors';
import type { Shield } from '../../index.js';
import { classifyFailure } from '../../transport/classify.js';
import { renderTable, toJson } from '../render.js';

export interface DoctorEndpointResult {
  readonly label: string;
  readonly url: string;
  readonly reachable: boolean;
  readonly version?: string;
  readonly latencyMs?: number;
  readonly slot?: bigint;
  readonly slotLag?: number;
  readonly agreesWithPool: boolean;
  readonly ws: 'ok' | 'failed' | 'skipped';
  readonly error?: string;
  readonly diagnosis?: string;
}

export interface DoctorReport {
  readonly endpoints: readonly DoctorEndpointResult[];
  readonly fees: ReadonlyArray<{ source: string; value?: bigint; error?: string }>;
  readonly jito?: { ok: boolean; tipLamports?: bigint; tipAccounts?: number; error?: string };
  readonly healthy: boolean;
}

/** Slot distance from the pool max beyond which a node is flagged as disagreeing. */
const AGREEMENT_TOLERANCE_SLOTS = 20n;

export async function runDoctor(
  shield: Shield,
  options: { wsCheck?: boolean } = {},
): Promise<DoctorReport> {
  const endpointResults = await Promise.all(
    shield.health.all().map(async (endpoint): Promise<Omit<DoctorEndpointResult, 'slotLag' | 'agreesWithPool'>> => {
      const started = Date.now();
      try {
        const versionResponse = await endpoint.transport<{
          result?: { 'solana-core'?: string };
          error?: { code: number; message?: string };
        }>({
          payload: { id: 'doctor', jsonrpc: '2.0', method: 'getVersion', params: [] },
        });
        const latencyMs = Date.now() - started;
        const slotResponse = await endpoint.transport<{ result?: number | bigint }>({
          payload: { id: 'doctor', jsonrpc: '2.0', method: 'getSlot', params: [{ commitment: 'confirmed' }] },
        });
        const slotRaw = slotResponse?.result;
        const slot = typeof slotRaw === 'bigint' ? slotRaw : typeof slotRaw === 'number' ? BigInt(slotRaw) : undefined;
        const ws =
          options.wsCheck === false || !endpoint.wsUrl
            ? 'skipped'
            : await checkWebSocket(endpoint.wsUrl);
        return {
          label: endpoint.label,
          url: endpoint.url,
          reachable: true,
          ...(versionResponse?.result?.['solana-core']
            ? { version: versionResponse.result['solana-core'] }
            : {}),
          latencyMs,
          ...(slot !== undefined ? { slot } : {}),
          ws,
        };
      } catch (err) {
        const failure = classifyFailure(err);
        return {
          label: endpoint.label,
          url: endpoint.url,
          reachable: false,
          ws: 'skipped',
          error: failure.message,
          diagnosis: diagnose(failure.httpStatus, failure.kind),
        };
      }
    }),
  );

  const slots = endpointResults.flatMap(r => (r.slot !== undefined ? [r.slot] : []));
  const maxSlot = slots.reduce((a, b) => (b > a ? b : a), 0n);
  const endpoints: DoctorEndpointResult[] = endpointResults.map(r => {
    const slotLag = r.slot !== undefined ? Number(maxSlot - r.slot) : undefined;
    return {
      ...r,
      ...(slotLag !== undefined ? { slotLag } : {}),
      agreesWithPool:
        r.slot === undefined ? false : maxSlot - r.slot <= AGREEMENT_TOLERANCE_SLOTS,
    };
  });

  const fees = await shield.fees.compare({ writableAddresses: [], level: 'medium' });

  let jito: DoctorReport['jito'];
  if (shield.jito) {
    try {
      const [tipLamports, tipAccounts] = await Promise.all([
        shield.jito.recommendedTipLamports(),
        shield.jito.getTipAccounts(),
      ]);
      jito = { ok: true, tipLamports, tipAccounts: tipAccounts.length };
    } catch (err) {
      jito = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const healthy =
    endpoints.some(e => e.reachable && e.agreesWithPool) &&
    fees.some(f => f.value !== undefined) &&
    (jito === undefined || jito.ok);

  return { endpoints, fees, ...(jito ? { jito } : {}), healthy };
}

function diagnose(httpStatus: number | undefined, kind: string): string {
  if (httpStatus === 401 || httpStatus === 403) return 'API key rejected — check credentials for this endpoint';
  if (httpStatus === 404) return 'URL looks wrong — RPC endpoint not found at this path';
  if (httpStatus === 429) return 'Rate limited — consider an rps cap in the endpoint config';
  if (kind === 'network') return 'Unreachable — DNS/TLS/connection failure';
  if (kind === 'timeout') return 'Endpoint accepted the connection but did not answer in time';
  return 'Unexpected failure — see error detail';
}

async function checkWebSocket(wsUrl: string): Promise<'ok' | 'failed' | 'skipped'> {
  const WS = (globalThis as { WebSocket?: new (url: string) => WebSocket }).WebSocket;
  if (!WS) return 'skipped';
  return new Promise(resolve => {
    let socket: WebSocket;
    try {
      socket = new WS(wsUrl);
    } catch {
      resolve('failed');
      return;
    }
    const timer = setTimeout(() => {
      socket.close();
      resolve('failed');
    }, 4000);
    socket.onopen = () => {
      clearTimeout(timer);
      socket.close();
      resolve('ok');
    };
    socket.onerror = () => {
      clearTimeout(timer);
      resolve('failed');
    };
  });
}

export function renderDoctorReport(report: DoctorReport, json: boolean): string {
  if (json) return toJson(report);
  const sections: string[] = [];
  sections.push(pc.bold('# Endpoints'));
  sections.push(
    renderTable(
      ['ENDPOINT', 'REACHABLE', 'VERSION', 'LATENCY', 'SLOT LAG', 'AGREES', 'WS', 'NOTES'],
      report.endpoints.map(e => [
        e.label,
        e.reachable ? pc.green('yes') : pc.red('NO'),
        e.version ?? '-',
        e.latencyMs !== undefined ? `${e.latencyMs}ms` : '-',
        e.slotLag !== undefined ? String(e.slotLag) : '-',
        e.agreesWithPool ? pc.green('yes') : pc.red('NO'),
        e.ws === 'ok' ? pc.green('ok') : e.ws === 'failed' ? pc.red('failed') : pc.dim('skipped'),
        e.diagnosis ?? e.error ?? '-',
      ]),
    ),
  );
  sections.push('');
  sections.push(pc.bold('# Fee sources'));
  sections.push(
    renderTable(
      ['SOURCE', 'STATUS', 'ESTIMATE (µlam/CU)'],
      report.fees.map(f => [
        f.source,
        f.value !== undefined ? pc.green('ok') : pc.red('failed'),
        f.value !== undefined ? f.value.toString() : (f.error ?? '-').slice(0, 60),
      ]),
    ),
  );
  if (report.jito) {
    sections.push('');
    sections.push(pc.bold('# Jito'));
    sections.push(
      report.jito.ok
        ? `${pc.green('ok')} — tip floor ${report.jito.tipLamports} lamports, ${report.jito.tipAccounts} tip accounts`
        : `${pc.red('failed')} — ${report.jito.error}`,
    );
  }
  sections.push('');
  sections.push(report.healthy ? pc.green('✔ healthy') : pc.red('✘ problems detected'));
  return sections.join('\n');
}
