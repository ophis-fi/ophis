import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import configureVite from '../vite.config'

it.each([['/', "'none'"], ['/private/', "'self'"]])('isolates wallet scripts and bounds framing for %s', async (base, ancestors) => {
  vi.stubEnv('RAILGUN_RPC_URL', 'http://127.0.0.1:8549')
  vi.stubEnv('VITE_RAILGUN_ASSET_BASE', base)
  try {
    const config = await configureVite({ command: 'serve', mode: 'test' })
    const production = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8')
      .match(/Content-Security-Policy: (.+)/)[1]
    for (const [policy, expectedAncestors] of [[production, "'none'"], [config.server.headers['Content-Security-Policy'], ancestors], [config.preview.headers['Content-Security-Policy'], ancestors]]) {
      const entries = policy.split(';').map((part) => {
        const [name, ...sources] = part.trim().split(/\s+/)
        return [name, sources]
      })
      expect(new Set(entries.map(([name]) => name)).size).toBe(entries.length)
      const directives = new Map(entries)
      expect(directives.get('frame-src')).toEqual(['https://verify.walletconnect.org'])
      expect(directives.get('frame-ancestors')).toEqual([expectedAncestors])
      expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"])
    }
  } finally { vi.unstubAllEnvs() }
})
