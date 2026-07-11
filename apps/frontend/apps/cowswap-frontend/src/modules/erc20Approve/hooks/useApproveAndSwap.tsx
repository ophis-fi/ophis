import { useCallback } from 'react'

import { useTradeSpenderAddress } from '@cowprotocol/balances-and-allowances'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { useWalletInfo } from '@cowprotocol/wallet'

import { Trans } from '@lingui/react/macro'

import { useTokenSupportsPermit } from 'modules/permit'
import { TradeType } from 'modules/trade'

import { ApproveCurrencyCallback, useApproveCurrency } from './useApproveCurrency'
import { useGeneratePermitInAdvanceToTrade } from './useGeneratePermitInAdvanceToTrade'

import { MAX_APPROVE_AMOUNT } from '../constants'
import {
  UpdateApproveProgressModalState,
  useIsPartialApproveSelectedByUser,
  useUpdateApproveProgressModalState,
} from '../state'
import { getIsTradeApproveResult } from '../utils/getIsTradeApproveResult'

export interface ApproveAndSwapProps {
  amountToApprove: CurrencyAmount<Currency>
  minAmountToSignForSwap?: CurrencyAmount<Currency>
  onApproveConfirm?: (transactionHash: string | null) => void
  ignorePermit?: boolean
  useModals?: boolean
}

export function useApproveAndSwap({
  amountToApprove,
  useModals,
  ignorePermit,
  onApproveConfirm,
  minAmountToSignForSwap,
}: ApproveAndSwapProps): () => Promise<void> {
  const { account } = useWalletInfo()
  const tradeSpenderAddress = useTradeSpenderAddress()
  const isPartialApproveEnabledByUser = useIsPartialApproveSelectedByUser()
  const handleApprove = useApproveCurrency(amountToApprove, useModals)
  const updateTradeApproveState = useUpdateApproveProgressModalState()

  const isPermitSupported = useTokenSupportsPermit(amountToApprove.currency, TradeType.SWAP) && !ignorePermit
  const generatePermitToTrade = useGeneratePermitInAdvanceToTrade(amountToApprove)

  const handlePermit = useCallback(async () => {
    if (isPermitSupported && onApproveConfirm) {
      const isPermitSigned = await generatePermitToTrade()

      // Only short-circuit as a "permit flow" when the permit actually signed.
      // generatePermitToTrade() returns false on ANY permit failure — a swallowed
      // error in generatePermitHook (rpc nonce read, token eip-2612 quirk), or the
      // user rejecting the signature. Previously this returned true unconditionally,
      // so a failed/rejected permit made the "Approve and Swap" CTA do nothing at
      // all (no approve tx, no order, no error) — the reported Unichain symptom.
      // On failure, fall through to the on-chain approve + swap below.
      if (isPermitSigned) {
        onApproveConfirm(null)
        return true
      }
    }

    return false
  }, [isPermitSupported, onApproveConfirm, generatePermitToTrade])

  return useCallback(async (): Promise<void> => {
    if (!account || !tradeSpenderAddress) return

    const isPermitFlow = await handlePermit()

    if (isPermitFlow) {
      return
    }

    await approveAndSwap({
      amountToApprove,
      onApproveConfirm,
      minAmountToSignForSwap,
      isPartialApproveEnabledByUser,
      handleApprove,
      updateTradeApproveState,
    })
  }, [
    handlePermit,
    amountToApprove,
    isPartialApproveEnabledByUser,
    handleApprove,
    onApproveConfirm,
    updateTradeApproveState,
    minAmountToSignForSwap,
    account,
    tradeSpenderAddress,
  ])
}

interface ApproveAndSwapContext {
  amountToApprove: CurrencyAmount<Currency>
  minAmountToSignForSwap?: CurrencyAmount<Currency>
  onApproveConfirm?: (transactionHash: string | null) => void
  isPartialApproveEnabledByUser?: boolean
  handleApprove: ApproveCurrencyCallback
  updateTradeApproveState: UpdateApproveProgressModalState
}

async function approveAndSwap({
  amountToApprove,
  onApproveConfirm,
  minAmountToSignForSwap,
  isPartialApproveEnabledByUser,
  handleApprove,
  updateTradeApproveState,
}: ApproveAndSwapContext): Promise<void> {
  const amountToApproveBig = BigInt(amountToApprove.quotient.toString())
  const toApprove = isPartialApproveEnabledByUser ? amountToApproveBig : MAX_APPROVE_AMOUNT
  const tx = await handleApprove(toApprove)

  if (tx && onApproveConfirm) {
    if (getIsTradeApproveResult(tx)) {
      const approvedAmount = tx.approvedAmount
      const minAmountToSignForSwapBig = minAmountToSignForSwap
        ? BigInt(minAmountToSignForSwap.quotient.toString())
        : amountToApproveBig
      const isApprovedAmountSufficient = Boolean(approvedAmount && approvedAmount >= minAmountToSignForSwapBig)

      if (isApprovedAmountSufficient) {
        onApproveConfirm(getApprovalTxHash(tx.txResponse))
      } else {
        updateTradeApproveState({ error: <Trans>Approved amount is not sufficient!</Trans> })
      }
    } else {
      onApproveConfirm(tx.transactionHash)
    }
  }
}

function getApprovalTxHash(txResponse: object): string | null {
  if ('transactionHash' in txResponse && typeof txResponse.transactionHash === 'string') {
    return txResponse.transactionHash
  }

  if ('hash' in txResponse && typeof txResponse.hash === 'string') {
    return txResponse.hash
  }

  return null
}
