import { NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { areAddressesEqual, PriceQuality } from '@cowprotocol/cow-sdk'

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
  if (cow.hasParamsChanged) return best
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
): boolean {
  const awaitingCow =
    !cow.error && (!cow.quote || cow.hasParamsChanged || cow.fetchParams?.priceQuality !== PriceQuality.OPTIMAL)
  return !!key && !isReviewing && (directPending || gasPending || awaitingCow)
}

export function canFundDirect(
  quote: DirectQuote | undefined,
  connected: boolean,
  nativeBalance: bigint | undefined,
): boolean {
  if (!quote) return false
  if (!connected || !quote.inputToken) return true
  if (nativeBalance === undefined) return false
  const approvalGas = ((quote.approvalGas || 0n) * 120n + 99n) / 100n
  return nativeBalance >= (quote.gasLimit + approvalGas) * quote.maxFeePerGas
}
