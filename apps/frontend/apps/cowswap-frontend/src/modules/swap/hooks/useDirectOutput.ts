import { useMemo } from 'react'

import { CurrencyAmount } from '@cowprotocol/currency'

import { useSwapDerivedState } from './useSwapDerivedState'

import { DirectQuote } from '../services/wholeToken/router.service'

export function useDirectOutput(
  quote: DirectQuote | undefined,
  currency: ReturnType<typeof useSwapDerivedState>['outputCurrency'],
): ReturnType<typeof useSwapDerivedState>['outputCurrencyAmount'] {
  return useMemo(
    () => (quote && currency ? CurrencyAmount.fromRawAmount(currency, quote.buyAmount.toString()) : null),
    [quote, currency],
  )
}
