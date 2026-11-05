import { afterEach, expect, it, vi } from 'vitest'
import type { SelectedBroadcaster } from '@railgun-community/shared-models'

const mocks = vi.hoisted(() => ({ find: vi.fn() }))
vi.mock('@railgun-community/waku-broadcaster-client-web', () => ({
  WakuBroadcasterClient: { isStarted: () => true, findBroadcastersForToken: mocks.find },
  BroadcasterTransaction: { create: vi.fn() },
}))
afterEach(() => vi.unstubAllEnvs())

it('discovers BNB stablecoin exits through the automatic WBNB fee asset', async () => {
  vi.stubEnv('VITE_RAILGUN_CHAIN_ID', '56')
  vi.stubEnv('VITE_RAILGUN_ENVIRONMENT', 'ethereum')
  const { CONFIG, FEE_SIGNER, TOKENS } = await import('./config')
  const fee: SelectedBroadcaster = { tokenAddress: TOKENS.WBNB.address, railgunAddress: FEE_SIGNER,
    tokenFee: { expiration: Date.now() + 120_000, feesID: 'native-fee', feePerUnitGas: '10', availableWallets: 1,
      relayAdapt: CONFIG.relayAdaptContract, reliability: 1 } }
  mocks.find.mockReturnValue([fee])
  const { selectBroadcaster } = await import('./broadcaster')
  expect(await selectBroadcaster(TOKENS.USDC.address, false, vi.fn())).toBe(fee)
  expect(mocks.find).toHaveBeenCalledWith(CONFIG.chain, TOKENS.WBNB.address, false, false)
})
