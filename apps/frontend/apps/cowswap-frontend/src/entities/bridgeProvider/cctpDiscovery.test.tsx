import { renderHook } from '@testing-library/react'

import { cctpToken } from 'entities/cctp'

import { useBridgeSupportedTokens } from './useBridgeSupportedTokens'

jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: () => true }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('./useBridgeProvidersIds', () => ({ useBridgeProvidersIds: () => [] }))
jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: {} }))
const mockTokens = { '0x171a4217b86a807a64eb94757db6849fb4bdbaa0': { chainId: 1, address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0', decimals: 18, symbol: 'FAKE', logoURI: '/btc.png' } }
jest.mock('@cowprotocol/tokens', () => ({ useTokensByAddressMapForChain: () => mockTokens }))
const mockResponse = { data: undefined, isLoading: true }
jest.mock('swr', () => ({ __esModule: true, default: () => mockResponse }))

it('publishes CCTP before generic discovery completes, preserving canonical identity and stable token objects', () => {
  const params = { sellChainId: 1, buyChainId: 5042, sellTokenAddress: cctpToken(1, 'cirBTC') }
  const { result, rerender } = renderHook(() => useBridgeSupportedTokens(params))
  const data = result.current.data
  expect(result.current.isLoading).toBe(false)
  expect(data?.tokens).toHaveLength(1)
  expect(data?.tokens[0]).toMatchObject({ chainId: 5042, decimals: 8, symbol: 'cirBTC', logoURI: '/btc.png' })
  rerender()
  expect(result.current.data).toBe(data)
  expect(result.current.data?.tokens[0]).toBe(data?.tokens[0])
})
