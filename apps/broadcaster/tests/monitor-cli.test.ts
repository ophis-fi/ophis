import { expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

it('emits only Prometheus metrics when the real CLI cannot reach its read node', async () => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing disposable loopback port.')
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  const directory = mkdtempSync(join(tmpdir(), 'ophis-monitor-cli-'))
  try {
    const output = join(directory, 'monitor.mjs')
    symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir')
    buildSync({ entryPoints: [new URL('../src/main.ts', import.meta.url).pathname], outfile: output,
      bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
    const result = spawnSync(process.execPath, [output, 'monitor', '--prometheus'], {
      env: { ...process.env, OPHIS_BROADCASTER_MODE: 'fork', OPHIS_BROADCASTER_ENABLED: '0',
        OPHIS_BROADCASTER_RPC: `http://127.0.0.1:${address.port}`, OPHIS_BROADCASTER_STATE: directory,
        OPHIS_BROADCASTER_OPERATOR_ADDRESS: '0x0000000000000000000000000000000000001234' },
      timeout: 25_000, encoding: 'utf8', maxBuffer: 64 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(2)
    expect(result.stdout).toContain('ophis_broadcaster_monitor_ok 0\n')
    expect(result.stdout).toContain('reason="stale-read-node"')
    expect(result.stdout.trim().split('\n').every((line) => line.startsWith('ophis_broadcaster_'))).toBe(true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}, 30_000)
