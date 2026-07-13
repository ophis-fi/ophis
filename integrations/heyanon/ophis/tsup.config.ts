import { exec } from 'child_process';
import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: { index: './src/index.ts' },
  // ESM-only: the @ophis/agent-swap core is ESM-only, so a CJS build would emit a require()
  // of an import-only package and fail to load. Publish a single .mjs entry.
  format: ['esm'],
  dts: false,
  treeshake: true,
  splitting: true,
  clean: !options.watch,
  onSuccess: async () => {
    exec('tsc --emitDeclarationOnly --declaration', (err) => {
      if (err) { console.error(err); if (!options.watch) process.exit(1); }
    });
  },
}));
