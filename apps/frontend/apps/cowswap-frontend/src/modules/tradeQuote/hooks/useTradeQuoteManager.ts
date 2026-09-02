import { useSetAtom } from 'jotai'
import { useMemo, useRef } from 'react'

import { PriceQuality, QuoteAndPost, SupportedChainId } from '@cowprotocol/cow-sdk'
import { BridgeQuoteResults, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { trackGa4Event } from 'ophis/analytics/track'

import { QuoteApiError, QuoteApiErrorCodes } from 'api/cowProtocol/errors/QuoteError'

import { useProcessUnsupportedTokenError } from './useProcessUnsupportedTokenError'

import { TradeQuoteState, updateTradeQuoteAtom } from '../state/tradeQuoteAtom'
import { SellTokenAddress } from '../state/tradeQuoteInputAtom'
import { TradeQuoteFetchParams } from '../types'

export interface TradeQuoteManager {
  setLoading(hasParamsChanged: boolean, quoteParams: QuoteBridgeRequest): void

  reset(): void

  resetTracking(): void

  onError(
    error: TradeQuoteState['error'],
    chainId: SupportedChainId,
    quoteParams: QuoteBridgeRequest,
    fetchParams: TradeQuoteFetchParams,
  ): void

  onResponse(
    data: QuoteAndPost,
    bridgeQuote: BridgeQuoteResults | null,
    fetchParams: TradeQuoteFetchParams,
    quoteParams: QuoteBridgeRequest,
  ): void
}

export function useTradeQuoteManager(sellTokenAddress: SellTokenAddress | undefined): TradeQuoteManager | null {
  const update = useSetAtom(updateTradeQuoteAtom)
  const processUnsupportedTokenError = useProcessUnsupportedTokenError()
  const lastQuoteParamsRef = useRef<QuoteBridgeRequest | null>(null)
  const lastTrackedQuoteParamsRef = useRef<QuoteBridgeRequest | null>(null)

  return useMemo((): TradeQuoteManager | null => {
    if (!sellTokenAddress) return null

    const setLoading = (hasParamsChanged: boolean, quoteParams: QuoteBridgeRequest): void => {
      lastQuoteParamsRef.current = quoteParams

      update(sellTokenAddress, {
        isLoading: true,
        hasParamsChanged,
      })
    }

    const reset = (): void => {
      lastQuoteParamsRef.current = null
      update(sellTokenAddress, { quote: null, isLoading: false })
    }

    const resetTracking = (): void => {
      lastTrackedQuoteParamsRef.current = null
    }

    const onError = (
      error: TradeQuoteState['error'],
      chainId: SupportedChainId,
      quoteParams: QuoteBridgeRequest,
      fetchParams: TradeQuoteFetchParams,
    ): void => {
      if (isStaleQuote(lastQuoteParamsRef.current, quoteParams)) {
        return
      }

      update(sellTokenAddress, {
        error,
        fetchParams,
        isLoading: false,
        hasParamsChanged: false,
        isBridgeQuote: quoteParams.sellTokenChainId !== quoteParams.buyTokenChainId,
      })

      if (error instanceof QuoteApiError && error.type === QuoteApiErrorCodes.UnsupportedToken) {
        processUnsupportedTokenError(error, chainId, quoteParams)
      }
    }

    const onResponse = (
      quote: QuoteAndPost,
      bridgeQuote: BridgeQuoteResults | null,
      fetchParams: TradeQuoteFetchParams,
      quoteParams: QuoteBridgeRequest,
    ): void => {
      if (isStaleQuote(lastQuoteParamsRef.current, quoteParams)) {
        return
      }

      const isOptimalQuote = fetchParams.priceQuality === PriceQuality.OPTIMAL

      if (isOptimalQuote && isStaleQuote(lastTrackedQuoteParamsRef.current, quoteParams)) {
        lastTrackedQuoteParamsRef.current = quoteParams
        trackGa4Event('quote_received', {
          sourceChainId: quoteParams.sellTokenChainId,
          destinationChainId: quoteParams.buyTokenChainId,
          isBridge: quoteParams.sellTokenChainId !== quoteParams.buyTokenChainId,
          orderKind: quoteParams.kind,
        })
      }

      update(sellTokenAddress, {
        quote,
        bridgeQuote,
        ...(isOptimalQuote ? { isLoading: false } : null),
        error: null,
        hasParamsChanged: false,
        fetchParams,
      })
    }

    return {
      setLoading,
      reset,
      resetTracking,
      onError,
      onResponse,
    }
  }, [update, processUnsupportedTokenError, sellTokenAddress])
}

function isStaleQuote(lastQuoteParams: QuoteBridgeRequest | null, quoteParams: QuoteBridgeRequest): boolean {
  // lastQuoteParams is set from setLoading, so onError/onResponse should always find a matching value there. If they
  // don't, then that's because reset was called, so we ignore all quotes until setLoading re-sets lastQuoteParams.
  if (!lastQuoteParams) return true

  // Typically, amount changes most often, so check it first. Then compare the
  // union of keys so adding or removing an optional request parameter also
  // produces a distinct analytics input state.
  if (lastQuoteParams.amount !== quoteParams.amount) return true

  const keys = new Set([...Object.keys(lastQuoteParams), ...Object.keys(quoteParams)])
  return [...keys].some(
    (key) => lastQuoteParams[key as keyof QuoteBridgeRequest] !== quoteParams[key as keyof QuoteBridgeRequest],
  )
}
