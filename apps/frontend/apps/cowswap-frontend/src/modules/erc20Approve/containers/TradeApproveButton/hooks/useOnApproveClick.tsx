import { useCallback } from 'react'

import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { MAX_APPROVE_AMOUNT } from '../../../constants'
import { useHandleApprovalError } from '../../TradeApproveModal/useHandleApprovalError'

type UseApproveParams = {
  isPermitSupported: boolean
  onApproveConfirm?: (txHash?: string) => void
  isPartialApproveEnabledByUser: boolean
  amountToApprove: CurrencyAmount<Currency>
  handleApprove: (amount: bigint) => Promise<null | undefined | { transactionHash: string }>
  generatePermitToTrade: () => Promise<boolean>
}

export function useOnApproveClick({
  isPermitSupported,
  onApproveConfirm,
  isPartialApproveEnabledByUser,
  amountToApprove,
  handleApprove,
  generatePermitToTrade,
}: UseApproveParams): () => Promise<void> {
  const handleApprovalError = useHandleApprovalError(amountToApprove.currency.symbol)
  return useCallback(async (): Promise<void> => {
    if (isPermitSupported && onApproveConfirm) {
      try {
        if (await generatePermitToTrade()) {
          onApproveConfirm()
          return
        }
      } catch (error) {
        handleApprovalError(error)
        return
      }
    }

    const toApprove = isPartialApproveEnabledByUser ? BigInt(amountToApprove.quotient.toString()) : MAX_APPROVE_AMOUNT
    const tx = await handleApprove(toApprove)
    if (tx && onApproveConfirm) {
      onApproveConfirm(tx.transactionHash)
    }
  }, [
    isPermitSupported,
    onApproveConfirm,
    isPartialApproveEnabledByUser,
    amountToApprove.quotient,
    handleApprove,
    generatePermitToTrade,
    handleApprovalError,
  ])
}
