import { WRAPPED_NATIVE_CURRENCIES, NATIVE_CURRENCIES, USDC_MAINNET } from '@cowprotocol/common-const'
import { OrderKind } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { renderHook } from '@testing-library/react'

import { useTradeQuote } from 'modules/tradeQuote'

import { useAmountsToSignFromQuote } from './useAmountsToSignFromQuote'
import { useDerivedTradeState } from './useDerivedTradeState'
import { useGetReceiveAmountInfo } from './useGetReceiveAmountInfo'
import { useSwapFundingAmount } from './useSwapFundingAmount'

import { TradeType } from '../types'

jest.mock('modules/tradeQuote', () => ({
  useTradeQuote: jest.fn(),
  getIsFastQuote: () => false,
  isQuoteExpired: () => false,
}))
jest.mock('@cowprotocol/wallet', () => ({
  useWalletInfo: () => ({ account: '0x1111111111111111111111111111111111111111' }),
}))
jest.mock('./useGetReceiveAmountInfo', () => ({ useGetReceiveAmountInfo: jest.fn() }))
jest.mock('./useIsWrapOrUnwrap', () => ({ useIsWrapOrUnwrap: () => false }))
jest.mock('./useAmountsToSignFromQuote', () => ({ useAmountsToSignFromQuote: jest.fn() }))
jest.mock('./useDerivedTradeState', () => ({ useDerivedTradeState: jest.fn() }))

it('funds the full BUY cap in native currency and rejects an outdated amount', () => {
  const native = NATIVE_CURRENCIES[1]
  const state = {
    inputCurrency: native,
    inputCurrencyAmount: CurrencyAmount.fromRawAmount(native, '1000'),
    outputCurrencyAmount: CurrencyAmount.fromRawAmount(USDC_MAINNET, '10000000'),
    orderKind: OrderKind.BUY,
    tradeType: TradeType.SWAP,
  }
  jest.mocked(useDerivedTradeState).mockReturnValue(state as ReturnType<typeof useDerivedTradeState>)
  jest.mocked(useAmountsToSignFromQuote).mockReturnValue({
    maximumSendSellAmount: CurrencyAmount.fromRawAmount(WRAPPED_NATIVE_CURRENCIES[1], '1150'),
    minimumReceiveBuyAmount: state.outputCurrencyAmount,
  })
  jest.mocked(useGetReceiveAmountInfo).mockReturnValue({
    amountsToSign: {
      sellAmount: CurrencyAmount.fromRawAmount(WRAPPED_NATIVE_CURRENCIES[1], '1100'),
      buyAmount: state.outputCurrencyAmount,
    },
  } as ReturnType<typeof useGetReceiveAmountInfo>)
  const order = {
    kind: OrderKind.BUY,
    sellToken: WRAPPED_NATIVE_CURRENCIES[1].address,
    buyToken: USDC_MAINNET.address,
    buyAmount: '10000000',
  }
  let quotedOwner = '0x1111111111111111111111111111111111111111'
  let quotedChain = 1
  jest.mocked(useTradeQuote).mockImplementation(
    () =>
      ({
        quote: {
          quoteResults: {
            quoteResponse: { quote: { ...order } },
            tradeParameters: { owner: quotedOwner },
            orderTypedData: { domain: { chainId: quotedChain } },
          },
        },
      }) as ReturnType<typeof useTradeQuote>,
  )
  const { result, rerender } = renderHook(() => useSwapFundingAmount(true))
  expect(result.current?.currency).toBe(native)
  expect(result.current?.quotient.toString()).toBe('1150')
  const { result: signedCap } = renderHook(() => useSwapFundingAmount())
  expect(signedCap.current?.quotient.toString()).toBe('1100')

  state.inputCurrency = WRAPPED_NATIVE_CURRENCIES[1]
  rerender()
  expect(result.current?.currency).toBe(WRAPPED_NATIVE_CURRENCIES[1])
  expect(result.current?.quotient.toString()).toBe('1150')

  quotedOwner = '0x2222222222222222222222222222222222222222'
  rerender()
  expect(result.current).toBeNull()
  quotedOwner = '0x1111111111111111111111111111111111111111'
  quotedChain = 10
  rerender()
  expect(result.current).toBeNull()
  quotedChain = 1

  order.buyAmount = '9000000'
  rerender()
  expect(result.current).toBeNull()
  order.buyAmount = '10000000'
  order.sellToken = USDC_MAINNET.address
  rerender()
  expect(result.current).toBeNull()

  state.outputCurrencyAmount = CurrencyAmount.fromRawAmount(new Token(10, USDC_MAINNET.address, 6), '10000000')
  rerender()
  expect(result.current).toBe(state.inputCurrencyAmount)

  state.tradeType = TradeType.LIMIT_ORDER
  rerender()
  expect(result.current).toBe(state.inputCurrencyAmount)

  state.tradeType = TradeType.SWAP
  state.orderKind = OrderKind.SELL
  rerender()
  expect(result.current).toBe(state.inputCurrencyAmount)
})
