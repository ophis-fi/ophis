import { useCallback } from 'react'

import { Currency, CurrencyAmount } from '@cowprotocol/currency'

import { MAX_APPROVE_AMOUNT } from '../../../constants'

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
  return useCallback(async (): Promise<void> => {
    if (isPermitSupported && onApproveConfirm) {
      const isPermitSigned = await generatePermitToTrade()
      // Only short-circuit when the permit actually signed; otherwise fall
      // through to the on-chain approve below. Mirrors the useApproveAndSwap
      // fix so a failed/rejected permit never leaves the CTA a silent no-op.
      // (This hook is currently unused; aligned to prevent the dead-button bug
      // from reappearing if it is ever wired up.)
      if (isPermitSigned) {
        onApproveConfirm()
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
  ])
}
