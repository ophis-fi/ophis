import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

it('selects the approved native-prepaid Arbitrum identity without advertising MEV protection', async () => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '42161')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'mainnet')
  const config = await import('./config')
  expect(config.CHAIN_ID).toBe(42161)
  expect(config.ENVIRONMENT).toBe('ethereum')
  expect(config.FEE_SIGNER).toBe(config.OPHIS_BROADCASTER)
  expect(config.PREPAID_BROADCASTERS[config.CHAIN_ID]).toEqual({
    operator: config.PREPAID_OPERATOR, railgunAddress: config.FEE_SIGNER, funding: 'native',
    expiresAt: Number.POSITIVE_INFINITY, maxGasPrice: 100_000_000n, maxTransactionCost: 1_000_000_000_000_000n,
  })
  expect(config.PROTECTED_BROADCASTERS[config.CHAIN_ID]).toBeUndefined()
  expect(config.PREPAID_BROADCASTERS[8453]).toBeUndefined()
  expect(config.PREPAID_BROADCASTERS[137]).toBeUndefined()
})
