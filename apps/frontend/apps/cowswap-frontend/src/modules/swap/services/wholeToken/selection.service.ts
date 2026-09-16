import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import type { useTradeQuote } from 'modules/tradeQuote'

import { DirectQuote, MPS } from './router.service'

export function selectDirect(
  best: DirectQuote | undefined,
  cow: ReturnType<typeof useTradeQuote>,
  now: number,
  depositGas: bigint,
): DirectQuote | undefined {
  if (!best || now - best.quotedAt >= 30000) return undefined
  if (!cow.quote) return best
  if ([cow.error, cow.hasParamsChanged].some(Boolean)) return best
  const params = cow.quote.quoteResults.tradeParameters
  const changed = [
    !areAddressesEqual(params.sellToken, best.inputToken || NATIVE_CURRENCY_ADDRESS),
    !areAddressesEqual(params.buyToken, MPS),
    params.amount !== best.budget.toString(),
  ].some(Boolean)
  if (changed) return best
  const amounts = cow.quote.quoteResults.amountsAndCosts
  return best.buyAmount > amounts.afterPartnerFees.buyAmount ||
    (best.buyAmount === amounts.afterPartnerFees.buyAmount &&
      best.netCost <
        amounts.amountsToSign.sellAmount + depositGas * ((best.maxFeePerGas + best.maxPriorityFeePerGas) / 2n))
    ? best
    : undefined
}
export function comparisonLoading(
  key: string,
  isReviewing: boolean,
  directPending: boolean,
  cow: ReturnType<typeof useTradeQuote>,
  gasPending: boolean,
  hasDirect: boolean,
): boolean {
  return (
    !!key &&
    !isReviewing &&
    (directPending || gasPending || (!hasDirect && (cow.isLoading || cow.hasParamsChanged || !cow.fetchParams)))
  )
}
