import { useMemo } from 'react'

import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { useAmountsToSignFromQuote } from 'modules/trade'

import { useGetUserApproveAmountState } from '../state'

/**
 * Returns the partial amount to sign for the approval transaction/permit
 * An explicit approval is a spending limit, even when a refreshed quote needs more.
 * Without a custom limit for this token and chain, use the quote's maximum spend.
 */
export function useGetPartialAmountToSignApprove(): CurrencyAmount<Currency> | null {
  const { maximumSendSellAmount } = useAmountsToSignFromQuote() || {}
  const { amountSetByUser } = useGetUserApproveAmountState() || {}

  return useMemo(() => {
    if (!maximumSendSellAmount) return null
    return amountSetByUser?.currency.equals(maximumSendSellAmount.currency) ? amountSetByUser : maximumSendSellAmount
  }, [maximumSendSellAmount, amountSetByUser])
}
