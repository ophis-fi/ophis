import { OrderKind, SupportedChainId as ChainId } from '@cowprotocol/cow-sdk'
import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { act, renderHook } from '@testing-library/react'

import { useAmountsToSignFromQuote, useDerivedTradeState } from 'modules/trade'
import { useTradeUsdAmounts } from 'modules/usdAmount'

import { useFiatValuePriceImpact } from './useFiatValuePriceImpact'

jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useDebounce: jest.fn((value) => value),
}))

jest.mock('modules/trade', () => ({
  useDerivedTradeState: jest.fn(),
  useAmountsToSignFromQuote: jest.fn(),
}))

jest.mock('modules/usdAmount', () => ({
  useTradeUsdAmounts: jest.fn(),
}))

const mockedUseDerivedTradeState = useDerivedTradeState as jest.MockedFunction<typeof useDerivedTradeState>
const mockedUseTradeUsdAmounts = useTradeUsdAmounts as jest.MockedFunction<typeof useTradeUsdAmounts>

function createToken(symbol: string, address: string): Token {
  return new Token(ChainId.SEPOLIA, address, 18, symbol, symbol)
}

describe('useFiatValuePriceImpact', () => {
  const inputToken = createToken('ETH', '0x0000000000000000000000000000000000000001')
  const outputToken = createToken('COW', '0x0000000000000000000000000000000000000002')

  beforeEach(() => {
    jest.useFakeTimers()
    jest.clearAllMocks()

    mockedUseDerivedTradeState.mockReturnValue({
      inputCurrency: inputToken,
      outputCurrency: outputToken,
      inputCurrencyAmount: CurrencyAmount.fromRawAmount(inputToken, 1),
      outputCurrencyAmount: CurrencyAmount.fromRawAmount(outputToken, 1),
    } as ReturnType<typeof useDerivedTradeState>)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('stops loading after 2 minutes when USD amounts never resolve', () => {
    mockedUseTradeUsdAmounts.mockReturnValue({
      inputAmount: { value: null, isLoading: true },
      outputAmount: { value: null, isLoading: true },
    })

    const { result } = renderHook(() => useFiatValuePriceImpact())

    expect(result.current).toEqual({ priceImpact: undefined, isLoading: true })

    act(() => {
      jest.advanceTimersByTime(120_000)
    })

    expect(result.current).toEqual({ priceImpact: undefined, isLoading: false })
  })
  it('values the actual signed input for whole-token sells instead of the unspent budget', () => {
    const sell = CurrencyAmount.fromRawAmount(inputToken, 70)
    const buy = CurrencyAmount.fromRawAmount(new Token(ChainId.SEPOLIA, outputToken.address, 0), 1)
    mockedUseDerivedTradeState.mockReturnValue({
      inputCurrency: inputToken,
      outputCurrency: buy.currency,
      inputCurrencyAmount: CurrencyAmount.fromRawAmount(inputToken, 100),
      outputCurrencyAmount: buy,
      orderKind: OrderKind.SELL,
    } as ReturnType<typeof useDerivedTradeState>)
    jest
      .mocked(useAmountsToSignFromQuote)
      .mockReturnValue({ maximumSendSellAmount: sell, minimumReceiveBuyAmount: buy })
    mockedUseTradeUsdAmounts.mockReturnValue({
      inputAmount: { value: null, isLoading: false },
      outputAmount: { value: null, isLoading: false },
    })
    renderHook(() => useFiatValuePriceImpact())
    expect(mockedUseTradeUsdAmounts).toHaveBeenCalledWith(sell, buy, inputToken, buy.currency)
  })
})
