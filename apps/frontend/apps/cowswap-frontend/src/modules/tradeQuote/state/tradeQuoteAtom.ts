import { atom } from 'jotai'

import { getCurrencyAddress } from '@cowprotocol/common-utils'
import { areAddressesEqual, getAddressKey, QuoteAndPost } from '@cowprotocol/cow-sdk'
import type { Currency } from '@cowprotocol/currency'
import { BridgeProviderQuoteError, BridgeQuoteResults } from '@cowprotocol/sdk-bridging'

import { isProviderNetworkDeprecatedAtom } from 'entities/common/isProviderNetworkDeprecated.atom'
import { isProviderNetworkUnsupportedAtom } from 'entities/common/isProviderNetworkUnsupported.atom'

import { derivedTradeStateAtom } from 'modules/trade/state/derivedTradeStateAtom'

import { QuoteApiError } from 'api/cowProtocol/errors/QuoteError'
import { isNonEvmRecipientChain, isRecipientAddress } from 'common/utils/recipientAddress.utils'

import { TradeQuoteFetchParams } from '../types'
import { getIsFastQuote } from '../utils/getIsFastQuote'

export interface TradeQuoteState {
  quote: QuoteAndPost | null
  isBridgeQuote: boolean | null
  bridgeQuote: BridgeQuoteResults | null
  fetchParams: TradeQuoteFetchParams | null
  error: QuoteApiError | BridgeProviderQuoteError | null
  hasParamsChanged: boolean
  isLoading: boolean
  localQuoteTimestamp: number | null
  /** Derived-only: the cached quote belongs to another destination asset or recipient. */
  isStaleDestination?: boolean
}

type SellTokenAddress = string

export const DEFAULT_TRADE_QUOTE_STATE: TradeQuoteState = {
  quote: null,
  bridgeQuote: null,
  isBridgeQuote: null,
  fetchParams: null,
  error: null,
  hasParamsChanged: false,
  isLoading: false,
  localQuoteTimestamp: null,
}

export const tradeQuotesAtom = atom<Record<SellTokenAddress, TradeQuoteState | undefined>>({})

export const updateTradeQuoteAtom = atom(
  null,
  (get, set, _sellTokenAddress: SellTokenAddress, nextState: Partial<TradeQuoteState>) => {
    set(tradeQuotesAtom, () => {
      const sellTokenAddress = getAddressKey(_sellTokenAddress)
      const prevState = get(tradeQuotesAtom)
      const prevQuote = prevState[sellTokenAddress] || DEFAULT_TRADE_QUOTE_STATE

      // Don't update state if Fast quote finished after Optimal quote
      if (
        prevQuote.fetchParams?.fetchStartTimestamp === nextState.fetchParams?.fetchStartTimestamp &&
        nextState.quote &&
        getIsFastQuote(nextState.fetchParams)
      ) {
        return { ...prevState }
      }

      const update: TradeQuoteState = {
        ...prevQuote,
        ...nextState,
        quote: typeof nextState.quote === 'undefined' ? prevQuote.quote : nextState.quote,
        localQuoteTimestamp: nextState.quote ? Math.ceil(Date.now() / 1000) : null,
      }

      return {
        ...prevState,
        [sellTokenAddress]: update,
      }
    })
  },
)

export const currentTradeQuoteAtom = atom<TradeQuoteState>((get) => {
  const isProviderNetworkUnsupported = get(isProviderNetworkUnsupportedAtom)
  const isProviderNetworkDeprecated = get(isProviderNetworkDeprecatedAtom)
  const state = get(derivedTradeStateAtom)
  const tradeQuotes = get(tradeQuotesAtom)

  const inputCurrency = state?.inputCurrency
  const outputCurrency = state?.outputCurrency

  if (!inputCurrency || !outputCurrency || isProviderNetworkUnsupported || isProviderNetworkDeprecated) {
    return DEFAULT_TRADE_QUOTE_STATE
  }

  const currentQuote = tradeQuotes[getAddressKey(getCurrencyAddress(inputCurrency))] || DEFAULT_TRADE_QUOTE_STATE
  return filterNonEvmQuote(currentQuote, inputCurrency, outputCurrency, state?.recipient)
})

function filterNonEvmQuote(
  currentQuote: TradeQuoteState,
  inputCurrency: Currency,
  outputCurrency: Currency,
  recipient: string | null | undefined,
): TradeQuoteState {
  const bridgeParams = currentQuote.bridgeQuote?.tradeParameters
  const isNonEvmDestination = isNonEvmRecipientChain(outputCurrency.chainId)
  if (![outputCurrency.chainId, bridgeParams?.buyTokenChainId].some(isNonEvmRecipientChain)) return currentQuote
  if (isNonEvmDestination && !isRecipientAddress(recipient, outputCurrency.chainId)) return DEFAULT_TRADE_QUOTE_STATE

  // Quotes are cached by sell token. Never relabel an earlier quote's amounts
  // when switching to or from a non-EVM destination while its quote is pending.
  const isCurrent =
    !!bridgeParams &&
    [
      bridgeParams.sellTokenChainId === inputCurrency.chainId,
      bridgeParams.buyTokenChainId === outputCurrency.chainId,
      areAddressesEqual(currentQuote.quote?.quoteResults.tradeParameters.sellToken, getCurrencyAddress(inputCurrency)),
      areAddressesEqual(bridgeParams.buyTokenAddress, getCurrencyAddress(outputCurrency)),
      areAddressesEqual(bridgeParams.bridgeRecipient || bridgeParams.receiver, recipient),
    ].every(Boolean)

  return isCurrent
    ? currentQuote
    : {
        ...currentQuote,
        quote: null,
        bridgeQuote: null,
        isBridgeQuote: null,
        localQuoteTimestamp: null,
        isStaleDestination: true,
      }
}
