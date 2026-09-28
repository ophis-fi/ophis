import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { OrderKind, PriceQuality, SupportedChainId } from '@cowprotocol/cow-sdk'

import { doQuotePolling, QuoteUpdateContext } from './doQuotePolling'

import { DEFAULT_TRADE_QUOTE_STATE } from '../state/tradeQuoteAtom'

function context(chainId: SupportedChainId): QuoteUpdateContext {
  return {
    currentQuote: DEFAULT_TRADE_QUOTE_STATE,
    quoteParams: {
      sellTokenChainId: chainId,
      buyTokenChainId: chainId,
      sellTokenAddress: '0x3600000000000000000000000000000000000000',
      buyTokenAddress: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1',
      sellTokenDecimals: 6,
      buyTokenDecimals: 6,
      amount: 1000000n,
      kind: OrderKind.SELL,
      account: '0x1111111111111111111111111111111111111111',
      appCode: 'test',
    },
    appData: undefined,
    fetchQuote: jest.fn().mockResolvedValue(undefined),
    hasParamsChanged: true,
    forceUpdate: false,
    isBrowserOnline: true,
    isConfirmOpen: false,
    fastQuote: true,
  }
}

it('requests only an optimal Arc quote while preserving fast quotes on other chains', () => {
  const arc = context(ARC_CHAIN_ID)
  expect(doQuotePolling(arc)).toBe(true)
  expect(arc.fetchQuote).toHaveBeenCalledTimes(1)
  expect(arc.fetchQuote).toHaveBeenCalledWith(expect.objectContaining({ priceQuality: PriceQuality.OPTIMAL }))
  const ethereum = context(SupportedChainId.MAINNET)
  doQuotePolling(ethereum)
  expect(ethereum.fetchQuote).toHaveBeenCalledTimes(2)
})

it('does not refresh hidden or offline tabs even when forced', () => {
  const hidden = { ...context(ARC_CHAIN_ID), forceUpdate: true, isBrowserOnline: false }
  expect(doQuotePolling(hidden)).toBe(false)
  expect(hidden.fetchQuote).not.toHaveBeenCalled()
})

it('does not overlap a slow request with a timed refresh', () => {
  const pending = {
    ...context(ARC_CHAIN_ID),
    currentQuote: { ...DEFAULT_TRADE_QUOTE_STATE, isLoading: true },
    hasParamsChanged: false,
    forceUpdate: true,
  }
  expect(doQuotePolling(pending)).toBe(false)
  expect(pending.fetchQuote).not.toHaveBeenCalled()
  expect(doQuotePolling({ ...pending, hasParamsChanged: true })).toBe(true)
  expect(pending.fetchQuote).toHaveBeenCalledTimes(1)
})
