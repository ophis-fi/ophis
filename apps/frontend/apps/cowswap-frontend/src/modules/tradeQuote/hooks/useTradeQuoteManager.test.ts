import { useSetAtom } from 'jotai'

import { OrderKind, PriceQuality, SupportedChainId, type QuoteAndPost } from '@cowprotocol/cow-sdk'
import { type QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { act, renderHook } from '@testing-library/react'
import { trackGa4Event } from 'ophis/analytics/track'

import { useTradeQuoteManager } from './useTradeQuoteManager'

import { type TradeQuoteFetchParams } from '../types'

jest.mock('jotai', () => ({ useSetAtom: jest.fn() }))
jest.mock('ophis/analytics/track', () => ({ trackGa4Event: jest.fn() }))
jest.mock('./useProcessUnsupportedTokenError', () => ({ useProcessUnsupportedTokenError: () => jest.fn() }))
jest.mock('../state/tradeQuoteAtom', () => ({ updateTradeQuoteAtom: Symbol('updateTradeQuoteAtom') }))

const mockedUseSetAtom = useSetAtom as jest.MockedFunction<typeof useSetAtom>
const updateQuote = jest.fn()
const quote = {} as QuoteAndPost
const optimalFetchParams = {
  hasParamsChanged: true,
  priceQuality: PriceQuality.OPTIMAL,
  fetchStartTimestamp: 1,
} satisfies TradeQuoteFetchParams

function quoteParams(amount: string): QuoteBridgeRequest {
  return {
    amount,
    sellTokenChainId: SupportedChainId.MAINNET,
    buyTokenChainId: SupportedChainId.MAINNET,
    kind: OrderKind.SELL,
  } as QuoteBridgeRequest
}

describe('useTradeQuoteManager GA4 events', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedUseSetAtom.mockReturnValue(updateQuote)
  })

  it('tracks the first optimal quote for each distinct input state', () => {
    const { result } = renderHook(() => useTradeQuoteManager('0x0000000000000000000000000000000000000001'))
    const manager = result.current
    if (!manager) throw new Error('Expected a quote manager')

    const firstParams = quoteParams('100')
    act(() => {
      manager.setLoading(true, firstParams)
      manager.onResponse(quote, null, optimalFetchParams, firstParams)
      manager.onResponse(quote, null, optimalFetchParams, firstParams)
    })

    const secondParams = quoteParams('200')
    act(() => {
      manager.setLoading(true, secondParams)
      manager.onResponse(quote, null, optimalFetchParams, secondParams)
    })

    expect(trackGa4Event).toHaveBeenCalledTimes(2)
    expect(trackGa4Event).toHaveBeenNthCalledWith(1, 'quote_received', {
      sourceChainId: SupportedChainId.MAINNET,
      destinationChainId: SupportedChainId.MAINNET,
      isBridge: false,
      orderKind: OrderKind.SELL,
    })
  })

  it('does not track a fast polling quote', () => {
    const { result } = renderHook(() => useTradeQuoteManager('0x0000000000000000000000000000000000000001'))
    const manager = result.current
    if (!manager) throw new Error('Expected a quote manager')

    const params = quoteParams('100')
    act(() => {
      manager.setLoading(true, params)
      manager.onResponse(quote, null, { ...optimalFetchParams, priceQuality: PriceQuality.FAST }, params)
    })

    expect(trackGa4Event).not.toHaveBeenCalled()
  })
})
