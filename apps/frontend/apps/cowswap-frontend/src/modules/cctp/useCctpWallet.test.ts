import { renderHook } from '@testing-library/react'

import { useCctpWallet } from './useCctpWallet'

let mockViemMigration = false
const mockWagmiWallet = { getAddresses: jest.fn() }
const mockLegacyProvider = { send: jest.fn() }
jest.mock('@cowprotocol/common-const', () => ({
  get LAUNCH_DARKLY_VIEM_MIGRATION() {
    return mockViemMigration
  },
}))
jest.mock('@cowprotocol/wallet-provider', () => ({ useWalletProvider: () => mockLegacyProvider }))
jest.mock('wagmi', () => ({ useWalletClient: () => ({ data: mockWagmiWallet }) }))

it('uses the same wallet backend as the application even when both providers are connected', async () => {
  mockViemMigration = false
  mockLegacyProvider.send.mockResolvedValue(['0x0000000000000000000000000000000000000001'])
  const legacy = renderHook(useCctpWallet)
  await legacy.result.current?.getAddresses()
  expect(mockLegacyProvider.send).toHaveBeenCalledWith('eth_accounts', [])
  expect(mockWagmiWallet.getAddresses).not.toHaveBeenCalled()
  legacy.unmount()
  mockViemMigration = true
  const wagmi = renderHook(useCctpWallet)
  expect(wagmi.result.current).toBe(mockWagmiWallet)
})
