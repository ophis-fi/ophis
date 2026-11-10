import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each([1, 56])('requires explicit fork configuration before accessing chain %i', (chainId) => {
  for (const upstream of [undefined, 'http://127.0.0.1:1']) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./prepaid-fork-roundtrip.mjs', import.meta.url))], {
      env: { OPHIS_PREPAID_TEST_CHAIN_ID: String(chainId), ...(upstream ? { OPHIS_PREPAID_TEST_UPSTREAM: upstream } : {}) },
      encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(upstream ? 'Select an explicit private evidence directory.' : 'Select an explicit public-state read RPC.')
    expect(result.stderr).not.toContain('ECONNREFUSED')
    expect(result.stdout).toBe('')
  }
})
