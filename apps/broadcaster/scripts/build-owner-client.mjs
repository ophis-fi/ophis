import { buildSync } from 'esbuild'
import { fileURLToPath } from 'node:url'

buildSync({
  entryPoints: [fileURLToPath(new URL('../src/unlock-client.ts', import.meta.url))],
  outfile: process.argv[2] ?? fileURLToPath(new URL('../dist/unlock-client.mjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  banner: { js: "import { createRequire as ownerCreateRequire } from 'node:module'; const require = ownerCreateRequire(import.meta.url);" },
})
