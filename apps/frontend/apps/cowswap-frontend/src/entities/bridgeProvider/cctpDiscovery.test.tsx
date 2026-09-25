import { ARC_CHAIN_ID } from '@cowprotocol/common-const'

import { renderHook } from '@testing-library/react'
import { cctpToken, useIsCctpEnabled } from 'entities/cctp'

import { useBridgeSupportedTokens } from './useBridgeSupportedTokens'

jest.mock('entities/cctp/useIsCctpEnabled', () => ({ useIsCctpEnabled: jest.fn(() => true) }))

jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: () => true }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('./useBridgeProvidersIds', () => ({ useBridgeProvidersIds: () => [] }))
jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: {} }))
const mockTokens = {
  '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': {
    chainId: 1,
    address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0',
    decimals: 18,
    symbol: 'FAKE',
    logoURI: '/btc.png',
  },
}
jest.mock('@cowprotocol/tokens', () => ({ useTokensByAddressMapForChain: () => mockTokens }))
const mockResponse = { data: undefined, isLoading: true }
jest.mock('swr', () => ({ __esModule: true, default: () => mockResponse }))

it('publishes CCTP before generic discovery completes, preserving canonical identity and stable token objects', () => {
  const params = { sellChainId: 1, buyChainId: ARC_CHAIN_ID, sellTokenAddress: cctpToken(1, 'cirBTC') }
  const { result, rerender } = renderHook(() => useBridgeSupportedTokens(params))
  const data = result.current.data
  // Partial CCTP results are usable, but must not invalidate a saved provider
  // token until provider discovery has finished.
  expect(result.current.isLoading).toBe(true)
  expect(data?.tokens).toHaveLength(1)
  expect(data?.tokens[0]).toMatchObject({ chainId: 5042, decimals: 8, symbol: 'cirBTC', logoURI: '/btc.png' })
  rerender()
  expect(result.current.data).toBe(data)
  expect(result.current.data?.tokens[0]).toBe(data?.tokens[0])
})

it('does not advertise CCTP-only tokens on surfaces that cannot execute them', () => {
  jest.mocked(useIsCctpEnabled).mockReturnValue(false)
  const { result } = renderHook(() => useBridgeSupportedTokens({ sellChainId: 1, buyChainId: ARC_CHAIN_ID }))
  expect(result.current.data).toBeUndefined()
})
