import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      'transport/index': 'src/transport/index.ts',
      'fees/index': 'src/fees/index.ts',
      'jito/index': 'src/jito/index.ts',
      'tx/index': 'src/tx/index.ts',
      'wallet/index': 'src/wallet/index.ts',
      'telemetry/index': 'src/telemetry/index.ts',
      'chaos/index': 'src/chaos/index.ts',
      'react/index': 'src/react/index.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    platform: 'neutral',
    treeshake: true,
  },
  {
    entry: { 'cli/main': 'src/cli/main.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
  },
]);
