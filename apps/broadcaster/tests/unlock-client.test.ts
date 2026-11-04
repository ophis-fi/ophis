import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { buildSync } from 'esbuild'

it('refuses fee-phrase recovery in a pipe before reading a key or connecting to the operator', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ophis-fee-client-'))
  try {
    const target = join(directory, 'unlock-client.mjs')
    buildSync({ entryPoints: [new URL('../src/unlock-client.ts', import.meta.url).pathname], outfile: target,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' })
    const result = spawnSync(process.execPath, [target, 'fee-phrase', '/nonexistent/key-must-not-be-opened'],
      { input: 'SHOW FEE PHRASE\n', timeout: 3000, encoding: 'utf8', env: { PATH: '/nonexistent' } })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No secret values were logged')
    expect(result.stderr).not.toContain('/nonexistent')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
