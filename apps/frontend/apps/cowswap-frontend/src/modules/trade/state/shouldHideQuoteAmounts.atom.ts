import { atom } from 'jotai'

import { currentTradeQuoteAtom, isQuoteExpired } from 'modules/tradeQuote'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { derivedTradeStateAtom } from './derivedTradeStateAtom'

export const shouldHideQuoteAmountsAtom = atom((get) => {
  const tradeQuote = get(currentTradeQuoteAtom)
  const { isLoading, hasParamsChanged, error, quote, bridgeQuote, isStaleDestination } = tradeQuote
  const destinationChainId = get(derivedTradeStateAtom)?.outputCurrency?.chainId

  // Background comparison must not blank an unchanged, still-valid same-chain quote.
  const hideWhileLoading =
    isLoading && [hasParamsChanged, !quote, !!bridgeQuote, isQuoteExpired(tradeQuote) !== false].some(Boolean)
  return Boolean(
    hideWhileLoading || error || isStaleDestination || (isNonEvmRecipientChain(destinationChainId) && !quote),
  )
})
