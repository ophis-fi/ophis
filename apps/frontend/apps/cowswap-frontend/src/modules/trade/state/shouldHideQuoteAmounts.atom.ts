import { atom } from 'jotai'

import { currentTradeQuoteAtom } from 'modules/tradeQuote'

import { isNonEvmRecipientChain } from 'common/utils/recipientAddress.utils'

import { derivedTradeStateAtom } from './derivedTradeStateAtom'

export const shouldHideQuoteAmountsAtom = atom((get) => {
  const { isLoading: isRateLoading, error: quoteError, quote, isStaleDestination } = get(currentTradeQuoteAtom)
  const destinationChainId = get(derivedTradeStateAtom)?.outputCurrency?.chainId

  /**
   * When a quote is loading, or there is an error in the quote result, we should not display values
   */
  return Boolean(
    isRateLoading || quoteError || isStaleDestination || (isNonEvmRecipientChain(destinationChainId) && !quote),
  )
})
