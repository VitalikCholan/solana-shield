import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadCliConfig } from '../../../src/cli/config.js';

const dir = mkdtempSync(join(tmpdir(), 'shield-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('loadCliConfig', () => {
  it('prefers the --endpoints flag', () => {
    const config = loadCliConfig({ endpoints: 'devnet, https://x.example.com' }, {});
    expect(config.endpoints).toEqual(['devnet', 'https://x.example.com']);
  });

  it('loads a config file and revives bigint fee ceilings', () => {
    const path = join(dir, 'shield.json');
    writeFileSync(
      path,
      JSON.stringify({
        endpoints: ['mainnet'],
        fees: { level: 'high', maxMicroLamportsPerCu: '250000' },
        jito: { regions: ['frankfurt'] },
      }),
    );
    const config = loadCliConfig({ config: path }, {});
    expect(config.endpoints).toEqual(['mainnet']);
    expect(config.fees?.maxMicroLamportsPerCu).toBe(250_000n);
    expect(config.fees?.level).toBe('high');
    expect(config.jito?.regions).toEqual(['frankfurt']);
  });

  it('falls back to the environment variable', () => {
    const config = loadCliConfig({}, { SOLANA_SHIELD_ENDPOINTS: 'a.example.com-not-used,devnet' });
    expect(config.endpoints).toHaveLength(2);
  });

  it('defaults to devnet when nothing is configured', () => {
    expect(loadCliConfig({}, {}).endpoints).toEqual(['devnet']);
  });
});
