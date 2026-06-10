import { existsSync, readFileSync } from 'node:fs';
import type { ShieldConfig } from '../config.js';

export interface CliGlobalOptions {
  readonly config?: string;
  readonly endpoints?: string;
}

interface RawFileConfig extends Omit<ShieldConfig, 'fees'> {
  readonly fees?: Omit<NonNullable<ShieldConfig['fees']>, 'maxMicroLamportsPerCu'> & {
    readonly maxMicroLamportsPerCu?: string | number;
  };
}

/**
 * Resolve the CLI's ShieldConfig:
 *   --endpoints flag → --config file → ./solana-shield.config.json
 *   → SOLANA_SHIELD_ENDPOINTS env → devnet fallback.
 */
export function loadCliConfig(options: CliGlobalOptions, env = process.env): ShieldConfig {
  if (options.endpoints) {
    return { endpoints: options.endpoints.split(',').map(s => s.trim()).filter(Boolean) };
  }
  const configPath = options.config ?? (existsSync('solana-shield.config.json') ? 'solana-shield.config.json' : undefined);
  if (configPath) {
    const raw = JSON.parse(readFileSync(configPath, 'utf8')) as RawFileConfig;
    return normalizeFileConfig(raw);
  }
  const fromEnv = env['SOLANA_SHIELD_ENDPOINTS'];
  if (fromEnv) {
    return { endpoints: fromEnv.split(',').map(s => s.trim()).filter(Boolean) };
  }
  return { endpoints: ['devnet'] };
}

function normalizeFileConfig(raw: RawFileConfig): ShieldConfig {
  const { fees, ...rest } = raw;
  if (!fees) return rest as ShieldConfig;
  const { maxMicroLamportsPerCu, ...feeRest } = fees;
  return {
    ...rest,
    fees: {
      ...feeRest,
      ...(maxMicroLamportsPerCu !== undefined
        ? { maxMicroLamportsPerCu: BigInt(maxMicroLamportsPerCu) }
        : {}),
    },
  } as ShieldConfig;
}
