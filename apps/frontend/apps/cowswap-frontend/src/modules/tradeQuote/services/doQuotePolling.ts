import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { PriceQuality } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { AppDataInfo } from '../../appData'
import { TradeQuoteState } from '../state/tradeQuoteAtom'
import { TradeQuoteFetchParams } from '../types'
import { quoteUsingSameParameters } from '../utils/quoteUsingSameParameters'

function isQuoteCached(quote: TradeQuoteState): boolean {
  const hasCachedResponse = quote.quote
  const hasCachedError = quote.error

  return Boolean(hasCachedResponse || hasCachedError)
}

function canUseFastQuote(params: QuoteBridgeRequest | undefined): boolean {
  return !!params && params.sellTokenChainId !== ARC_CHAIN_ID && params.sellTokenChainId === params.buyTokenChainId
}

export interface QuoteUpdateContext {
  currentQuote: TradeQuoteState
  quoteParams: QuoteBridgeRequest | undefined
  appData: AppDataInfo['doc'] | undefined
  fetchQuote(fetchParams: TradeQuoteFetchParams): Promise<void>
  hasParamsChanged: boolean
  forceUpdate: boolean
  isBrowserOnline: boolean
  isConfirmOpen: boolean
  fastQuote?: boolean
  hasSmartSlippage?: boolean
}

export function doQuotePolling({
  currentQuote,
  quoteParams,
  appData,
  forceUpdate,
  hasParamsChanged,
  isBrowserOnline,
  isConfirmOpen,
  fastQuote,
  fetchQuote,
  hasSmartSlippage,
}: QuoteUpdateContext): boolean {
  const currentQuoteAppDataDoc = currentQuote.quote?.quoteResults.appDataInfo.doc

  // Forced refreshes bypass the cache, never the hidden/offline-tab guard.
  if (!isBrowserOnline) return false

  if (!forceUpdate) {
    // Don't fetch quote if the parameters are the same
    // Also avoid quote refresh when only appData.quote (contains slippage) is changed
    // Important! We should skip quote updating only if there is no quote response
    if (
      isQuoteCached(currentQuote) &&
      quoteUsingSameParameters(currentQuote, quoteParams, currentQuoteAppDataDoc, appData, hasSmartSlippage)
    ) {
      return false
    }
  }

  const fetchStartTimestamp = Date.now()

  // Arc's direct solver already returns promptly; a second quote wastes its limited RPC budget.
  if (fastQuote && !isConfirmOpen && canUseFastQuote(quoteParams)) {
    fetchQuote({ hasParamsChanged, priceQuality: PriceQuality.FAST, fetchStartTimestamp })
  }
  fetchQuote({ hasParamsChanged, priceQuality: PriceQuality.OPTIMAL, fetchStartTimestamp })

  return true
}
