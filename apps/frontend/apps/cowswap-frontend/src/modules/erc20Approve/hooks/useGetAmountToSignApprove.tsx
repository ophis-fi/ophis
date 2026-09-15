import { useMemo } from 'react'

import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { useAmountsToSignFromQuote } from 'modules/trade'

import { useNeedsApproval } from 'common/hooks/useNeedsApproval'

import { useGetPartialAmountToSignApprove } from './useGetPartialAmountToSignApprove'
import { useIsPartialApprovalModeSelected } from './useIsPartialApprovalModeSelected'

import { MAX_APPROVE_AMOUNT } from '../constants'
import { useIsPartialApproveSelectedByUser } from '../state'

/**
 * Returns the amount to sign for the approval transaction/permit
 * If no approval is needed, it returns 0
 * Otherwise it checks if partial approval is enabled and selected by the user.
 * If so, it returns the partial amount to sign.
 * Otherwise, it returns the maximum approve amount (unlimited).
 */
export function useGetAmountToSignApprove(): CurrencyAmount<Currency> | null {
  const partialAmountToSign = useGetPartialAmountToSignApprove()
  const { maximumSendSellAmount } = useAmountsToSignFromQuote() || {}
  // Allowance must cover the order, even when the user chose a smaller approval cap.
  const isApprovalNeeded = useNeedsApproval(maximumSendSellAmount)
  const isPartialApprovalSelectedByUser = useIsPartialApproveSelectedByUser()
  const isPartialApprovalEnabledInSettings = useIsPartialApprovalModeSelected()

  return useMemo(() => {
    if (!partialAmountToSign) return null

    if (!isApprovalNeeded) return CurrencyAmount.fromRawAmount(partialAmountToSign.currency, '0')

    if (isPartialApprovalSelectedByUser && isPartialApprovalEnabledInSettings) {
      return partialAmountToSign
    }

    return CurrencyAmount.fromRawAmount(partialAmountToSign.currency, MAX_APPROVE_AMOUNT.toString())
  }, [partialAmountToSign, isApprovalNeeded, isPartialApprovalSelectedByUser, isPartialApprovalEnabledInSettings])
}
