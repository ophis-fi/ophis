import { afterEach, expect, it, vi } from 'vitest'
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it('allows an explicit loopback history gateway only for a restricted Base mainnet pilot', async () => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '8453')
  const { settings } = await import('../src/config')
  const env = { OPHIS_BROADCASTER_CHAIN_ID: '8453', OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9',
    OPHIS_BROADCASTER_ADMISSION: 'pilot', OPHIS_BROADCASTER_BASE_HISTORY_ORIGIN: 'http://127.0.0.1:8787' }
  expect(settings(env).baseHistoryOrigin).toBe(env.OPHIS_BROADCASTER_BASE_HISTORY_ORIGIN)
  expect(settings({ ...env, OPHIS_BROADCASTER_BASE_HISTORY_ORIGIN: 'https://swap.ophis.fi' }).baseHistoryOrigin).toBe('https://swap.ophis.fi')
  for (const value of ['https://example.com', 'https://swap.ophis.fi/path', 'http://user@localhost:8787'])
    expect(() => settings({ ...env, OPHIS_BROADCASTER_BASE_HISTORY_ORIGIN: value })).toThrow()
  expect(() => settings({ ...env, OPHIS_BROADCASTER_ADMISSION: 'public' })).toThrow('Untrusted')
  expect(() => settings({ ...env, OPHIS_BROADCASTER_MODE: 'fork' })).toThrow('only for Base mainnet')
})

it('rejects unused Base history overrides on another chain', async () => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', '1')
  const { settings } = await import('../src/config')
  expect(() => settings({ OPHIS_BROADCASTER_RPC: 'http://127.0.0.1:9',
    OPHIS_BROADCASTER_BASE_HISTORY_ORIGIN: 'https://swap.ophis.fi' })).toThrow('only for Base mainnet')
})
