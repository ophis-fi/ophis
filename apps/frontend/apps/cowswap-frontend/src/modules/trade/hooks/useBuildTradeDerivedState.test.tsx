import { atom, createStore, Provider } from 'jotai'
import { ReactNode } from 'react'

import { ARC_CHAIN_ID, ARC_USDC, NATIVE_CURRENCIES, TokenWithLogo, USDC } from '@cowprotocol/common-const'
import { getAddressKey, OrderKind } from '@cowprotocol/cow-sdk'
import { userAddedTokensAtom, useTokenBySymbolOrAddress, useTokensByAddressMapForChain } from '@cowprotocol/tokens'

import { act, renderHook } from '@testing-library/react'
import { useBridgeSupportedTokens } from 'entities/bridgeProvider'

import { useBuildTradeDerivedState } from './useBuildTradeDerivedState'

import { ExtendedTradeRawState } from '../types/TradeRawState'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  ARC_ENABLED_CHAIN_IDS: [5042],
}))
jest.mock('@cowprotocol/tokens', () => ({
  userAddedTokensAtom: jest.requireActual('jotai').atom({}),
  useTokenBySymbolOrAddress: jest.fn(() => null),
  useTokensByAddressMapForChain: jest.fn(() => ({})),
}))
jest.mock('entities/bridgeProvider', () => ({ useBridgeSupportedTokens: jest.fn(() => ({ data: undefined })) }))
jest.mock('modules/combinedBalances', () => ({ useCurrencyAmountBalanceCombined: () => null }))
jest.mock('modules/usdAmount', () => ({ useTradeUsdAmounts: () => ({ inputAmount: {}, outputAmount: {} }) }))

const custom = TokenWithLogo.fromToken({
  chainId: ARC_CHAIN_ID,
  address: '0x000000000000000000000000000000000000abcd',
  decimals: 8,
  symbol: 'CUSTOM',
  name: 'Custom Arc token',
})
const receiveFirst: ExtendedTradeRawState = {
  chainId: 1,
  targetChainId: ARC_CHAIN_ID,
  inputCurrencyId: null,
  outputCurrencyId: custom.address,
  inputCurrencyAmount: null,
  outputCurrencyAmount: null,
  orderKind: OrderKind.SELL,
}

beforeEach(() => {
  jest.mocked(useTokenBySymbolOrAddress).mockReturnValue(null)
  jest.mocked(useTokensByAddressMapForChain).mockReturnValue({})
  jest
    .mocked(useBridgeSupportedTokens)
    .mockReturnValue({ data: undefined } as ReturnType<typeof useBridgeSupportedTokens>)
})

it.each([null, '_'])(
  'retains a destination catalog token with empty source %s until sell is chosen',
  (inputCurrencyId) => {
    jest.mocked(useTokensByAddressMapForChain).mockReturnValue({ [getAddressKey(custom.address)]: custom })
    const state = atom({ ...receiveFirst, inputCurrencyId })
    const store = createStore()
    const { result } = renderHook(() => useBuildTradeDerivedState(state, true), {
      wrapper: ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>,
    })
    expect(result.current.outputCurrency).toBe(custom)
    expect(useTokensByAddressMapForChain).toHaveBeenCalledWith(ARC_CHAIN_ID)
    act(() => {
      // The selected source is still resolving; catalog metadata must not enable a bridge.
      store.set(state, { ...receiveFirst, inputCurrencyId: ARC_USDC.address })
    })
    expect(result.current.outputCurrency).toBeNull()
  },
)

it.each([null, '_'])(
  'retains imported tokens with empty source %s independently of the token-list environment',
  (inputCurrencyId) => {
    const store = createStore()
    store.set(userAddedTokensAtom, { [ARC_CHAIN_ID]: { [getAddressKey(custom.address)]: custom } })
    const state = atom({ ...receiveFirst, inputCurrencyId })
    const { result } = renderHook(() => useBuildTradeDerivedState(state, true), {
      wrapper: ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>,
    })
    expect(result.current.outputCurrency).toEqual(custom)
    act(() => store.set(state, { ...receiveFirst, inputCurrencyId: ARC_USDC.address }))
    expect(result.current.outputCurrency).toBeNull()
  },
)

it('restores an imported destination from a legacy mixed-case storage key', () => {
  const store = createStore()
  const legacyKey = custom.address.toUpperCase().replace('0X', '0x')
  expect(legacyKey).not.toBe(getAddressKey(custom.address))
  store.set(userAddedTokensAtom, { [ARC_CHAIN_ID]: { [legacyKey]: custom } })
  const state = atom({ ...receiveFirst, inputCurrencyId: '_' })
  const { result } = renderHook(() => useBuildTradeDerivedState(state, true), {
    wrapper: ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>,
  })
  expect(result.current.outputCurrency).toEqual(custom)
})

it('keeps canonical bridge metadata ahead of destination catalog metadata', () => {
  jest.mocked(useTokensByAddressMapForChain).mockReturnValue({ [getAddressKey(ARC_USDC.address)]: custom })
  jest
    .mocked(useBridgeSupportedTokens)
    .mockReturnValue({ data: { tokens: [ARC_USDC], isRouteAvailable: true } } as ReturnType<
      typeof useBridgeSupportedTokens
    >)
  const state = atom({ ...receiveFirst, outputCurrencyId: ARC_USDC.address })
  const { result } = renderHook(() => useBuildTradeDerivedState(state, true))
  expect(result.current.outputCurrency).toBe(ARC_USDC)
})

it('queries the selected sell token after receive-first discovery returned an empty result', () => {
  const sellToken = USDC[1]
  jest.mocked(useTokensByAddressMapForChain).mockReturnValue({ [getAddressKey(custom.address)]: custom })
  jest.mocked(useTokenBySymbolOrAddress).mockImplementation((id) => (id === sellToken.address ? sellToken : null))
  jest.mocked(useBridgeSupportedTokens).mockImplementation(
    (params) =>
      ({
        data: {
          tokens: params?.sellTokenAddress === sellToken.address ? [custom] : [],
          isRouteAvailable: params?.sellTokenAddress === sellToken.address,
        },
      }) as ReturnType<typeof useBridgeSupportedTokens>,
  )
  const state = atom({ ...receiveFirst, inputCurrencyId: '_' })
  const store = createStore()
  const { result } = renderHook(() => useBuildTradeDerivedState(state, true), {
    wrapper: ({ children }: { children: ReactNode }): ReactNode => <Provider store={store}>{children}</Provider>,
  })
  expect(result.current.outputCurrency).toBe(custom)
  act(() => store.set(state, { ...receiveFirst, inputCurrencyId: sellToken.address }))
  expect(useBridgeSupportedTokens).toHaveBeenLastCalledWith({
    sellChainId: 1,
    buyChainId: ARC_CHAIN_ID,
    sellTokenAddress: sellToken.address,
  })
  expect(result.current.outputCurrency).toBe(custom)
})

it('retains the destination native token without using the source native token', () => {
  const native = NATIVE_CURRENCIES[ARC_CHAIN_ID]
  const state = atom({ ...receiveFirst, outputCurrencyId: native.address })
  const { result } = renderHook(() => useBuildTradeDerivedState(state, true))
  expect(result.current.outputCurrency).toBe(native)
})
