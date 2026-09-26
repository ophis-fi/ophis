import { renderHook } from '@testing-library/react'
import { cctpToken, useIsCctpEnabled } from 'entities/cctp'

import { useBridgeSupportedTokens } from './useBridgeSupportedTokens'

jest.mock('entities/cctp/useIsCctpEnabled', () => ({ useIsCctpEnabled: jest.fn(() => true) }))

jest.mock('@cowprotocol/common-hooks', () => ({ useIsBridgingEnabled: () => true }))
jest.mock('common/constants/featureFlags', () => ({ CCTP_ENABLED: true }))
jest.mock('./useBridgeProvidersIds', () => ({ useBridgeProvidersIds: () => [] }))
jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: {} }))
const mockTokens = {
  '0x7de283100d916cfc7822a7664bcd7e9371e78d32': {
    chainId: 5042,
    address: '0x7de283100d916cfc7822a7664bcd7e9371e78d32',
    decimals: 8,
    symbol: 'STALE',
    name: 'Tesla (Ondo Tokenized)',
    logoURI: '/logos/token-tslaon.png',
  },
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
  const params = { sellChainId: 1, buyChainId: 5042, sellTokenAddress: cctpToken(1, 'cirBTC') }
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

it('uses catalog display metadata for bridge assets without replacing their registry identity', () => {
  const params = { sellChainId: 1, buyChainId: 5042, sellTokenAddress: cctpToken(1, 'TSLAon') }
  const { result } = renderHook(() => useBridgeSupportedTokens(params))
  expect(result.current.data?.tokens[0]).toMatchObject({
    chainId: 5042,
    address: cctpToken(5042, 'TSLAon'),
    decimals: 18,
    symbol: 'TSLAon',
    name: 'Tesla (Ondo Tokenized)',
    logoURI: '/logos/token-tslaon.png',
  })
})

it('does not advertise CCTP-only tokens on surfaces that cannot execute them', () => {
  jest.mocked(useIsCctpEnabled).mockReturnValue(false)
  const { result } = renderHook(() => useBridgeSupportedTokens({ sellChainId: 1, buyChainId: 5042 }))
  expect(result.current.data).toBeUndefined()
})
