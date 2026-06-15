#!/usr/bin/env node
/**
 * Runs the functions/ validator tests (tests/functions/) on Node's built-in test
 * runner using native TypeScript type-stripping.
 *
 * Type-stripping (`--experimental-strip-types`) requires Node >= 22.6. The repo's
 * `engines` also allows Node 20.19+, where that flag does not exist and
 * `node --test` aborts with a cryptic `bad option: --experimental-strip-types`.
 * This wrapper version-guards so a Node 20 developer gets an actionable message
 * instead of a confusing crash. CI runs these tests on Node 22 (see ci.yml), so
 * the hard gate is unaffected by this guard.
 *
 * Why no extra dependency: the alternative is a TS runner like `tsx`, but these
 * are zero-dependency tests intentionally (the validators are the sole injection
 * filter for /api/intent and must stay trivially runnable). Node 22+ is the
 * supported toolchain for running them.
 */
import { spawnSync } from 'node:child_process'

const [major, minor] = process.versions.node.split('.').map(Number)
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6)

if (!supportsStripTypes) {
  console.error(
    `\n  test:functions needs Node >= 22.6 for native TypeScript type-stripping (you have v${process.versions.node}).\n` +
      `  CI runs these tests on Node 22; please switch locally (e.g. \`nvm use 22\`) to run them.\n`,
  )
  process.exit(1)
}

const res = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/functions/*.test.ts'], {
  stdio: 'inherit',
})
process.exit(res.status ?? 1)
