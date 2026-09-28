import { ARC_USDC, USDC_MAINNET } from '@cowprotocol/common-const'
import { CurrencyAmount } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'
import { useLocation } from 'react-router'

import { useDerivedTradeState } from './useDerivedTradeState'
import { useSetupTradeAmountsFromUrl } from './useSetupTradeAmountsFromUrl'
import { useTradeState } from './useTradeState'

import { DEFAULT_TRADE_DERIVED_STATE } from '../types/TradeDerivedState'
import { TradeType } from '../types/TradeType'

jest.mock('react-router', () => ({ useLocation: jest.fn() }))
jest.mock('common/hooks/useNavigate', () => ({ useNavigate: () => jest.fn() }))
jest.mock('./useDerivedTradeState')
jest.mock('./useTradeState')

const updateState = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useLocation).mockReturnValue({ search: '' } as ReturnType<typeof useLocation>)
  jest.mocked(useTradeState).mockReturnValue({ updateState } as ReturnType<typeof useTradeState>)
  jest.mocked(useDerivedTradeState).mockReturnValue({
    ...DEFAULT_TRADE_DERIVED_STATE,
    inputCurrency: ARC_USDC,
    outputCurrency: ARC_USDC,
    tradeType: TradeType.SWAP,
  })
})

it('does not request an unsolicited one-token quote on an empty Arc swap', () => {
  renderHook(() => useSetupTradeAmountsFromUrl({}))
  expect(updateState).not.toHaveBeenCalled()
})

it('preserves an explicitly entered Arc amount', () => {
  jest.mocked(useDerivedTradeState).mockReturnValue({
    ...DEFAULT_TRADE_DERIVED_STATE,
    inputCurrency: ARC_USDC,
    inputCurrencyAmount: CurrencyAmount.fromRawAmount(ARC_USDC, 10_000_000),
    tradeType: TradeType.SWAP,
  })
  renderHook(() => useSetupTradeAmountsFromUrl({}))
  expect(updateState).not.toHaveBeenCalled()
})

it.each(['sellAmount', 'buyAmount'])('still restores an explicit Arc URL %s', (field) => {
  jest.mocked(useLocation).mockReturnValue({ search: `?${field}=10` } as ReturnType<typeof useLocation>)
  renderHook(() => useSetupTradeAmountsFromUrl({}))
  expect(updateState).toHaveBeenCalledWith(
    expect.objectContaining({
      [field === 'sellAmount' ? 'inputCurrencyAmount' : 'outputCurrencyAmount']: expect.anything(),
    }),
  )
})

it.each([
  [USDC_MAINNET, TradeType.SWAP],
  [ARC_USDC, TradeType.LIMIT_ORDER],
])('preserves default price discovery outside Arc swaps', (inputCurrency, tradeType) => {
  jest.mocked(useDerivedTradeState).mockReturnValue({ ...DEFAULT_TRADE_DERIVED_STATE, inputCurrency, tradeType })
  renderHook(() => useSetupTradeAmountsFromUrl({}))
  expect(updateState).toHaveBeenCalledWith(expect.objectContaining({ inputCurrencyAmount: expect.anything() }))
})
