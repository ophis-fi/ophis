import { useAtom } from 'jotai'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import {
  recordUncertainOtcTransaction,
  removeUncertainOtcTransaction,
  uncertainOtcTransactionsAtom,
} from 'entities/otc'

import { useOtcAllowanceCooldown } from './useOtcAllowanceCooldown'
import { useOtcSubmitCallback, type OtcSuccessfulTransaction } from './useOtcSubmitCallback'

import type {
  OtcConfirmedCallback,
  OtcWalletSubmitter,
  OtcWriteClient,
  OtcWriteIntent,
  OtcWriteRuntimeAuthorization,
} from './otcWrite.types'
import type { Address, Hex } from 'viem'

interface AllowanceRead {
  allowance: bigint
}

export type RefreshOtcAllowance = () => Promise<AllowanceRead | null | undefined>

export interface OtcSubmissionOptions {
  writeClient: OtcWriteClient | null
  wallet: OtcWalletSubmitter | null
  authorization: OtcWriteRuntimeAuthorization
  resetKey: string
  account: Address | undefined
  requiredAllowance: bigint | null | undefined
  refreshAllowance: RefreshOtcAllowance
  onConfirmed: OtcConfirmedCallback | undefined
}

export interface OtcSubmissionState {
  pendingIntent: OtcWriteIntent['kind'] | 'switch' | null
  error: string | null
  successHash: Hex | null
  terminalConfirmed: boolean
  uncertainHash: Hex | null
  recoveryRequired: boolean
  allowanceCooldown: boolean
  clearUncertainTransaction(): void
  setError(error: string | null): void
  submit(intent: OtcWriteIntent, execution: boolean): Promise<void>
}

function submissionContextKey(
  resetKey: string,
  account: Address | undefined,
  authorization: OtcWriteRuntimeAuthorization,
): string {
  const { readFlag, writeFlag, isLocal, writeMode } = authorization
  return [resetKey, account ?? '', readFlag, writeFlag, isLocal, writeMode ?? ''].join('\u0000')
}

function successfulTransactionState(success: OtcSuccessfulTransaction | null): {
  successHash: Hex | null
  terminalConfirmed: boolean
} {
  return { successHash: success?.transactionHash ?? null, terminalConfirmed: success?.terminal ?? false }
}

export function useOtcSubmission(options: OtcSubmissionOptions): OtcSubmissionState {
  const { writeClient, wallet, authorization, resetKey, account, requiredAllowance, refreshAllowance, onConfirmed } =
    options
  const [pendingIntent, setPendingIntent] = useState<OtcWriteIntent['kind'] | 'switch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<OtcSuccessfulTransaction | null>(null)
  const [uncertainTransactions, setUncertainTransactions] = useAtom(uncertainOtcTransactionsAtom)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const submissionContext = submissionContextKey(resetKey, account, authorization)
  const uncertainKey = account ? `${getAddressKey(account)}\u0000${resetKey}` : null
  const uncertainHash = uncertainKey ? (uncertainTransactions[uncertainKey]?.transactionHash ?? null) : null
  const setUncertainHash = useCallback(
    (transactionHash: Hex) => {
      if (!uncertainKey) return
      setUncertainTransactions((current) => recordUncertainOtcTransaction(current, uncertainKey, transactionHash))
    },
    [setUncertainTransactions, uncertainKey],
  )
  const clearUncertainTransaction = useCallback(
    (expectedHash?: Hex) => {
      if (!uncertainKey) return
      setUncertainTransactions((current) => removeUncertainOtcTransaction(current, uncertainKey, expectedHash))
    },
    [setUncertainTransactions, uncertainKey],
  )
  const contextGeneration = useRef(0)
  const inFlightGeneration = useRef<number | null>(null)
  const [allowanceCooldown, beginAllowanceCooldown] = useOtcAllowanceCooldown(refreshAllowance, submissionContext)

  useLayoutEffect(() => {
    contextGeneration.current += 1
    inFlightGeneration.current = null
    setPendingIntent(null)
    setError(null)
    setSuccess(null)
    setRecoveryRequired(false)
    return () => {
      contextGeneration.current += 1
      inFlightGeneration.current = null
    }
  }, [submissionContext, wallet, writeClient])

  const submit = useOtcSubmitCallback({
    writeClient,
    wallet,
    authorization,
    requiredAllowance,
    refreshAllowance,
    contextGeneration,
    inFlightGeneration,
    beginAllowanceCooldown,
    onConfirmed,
    setPendingIntent,
    setError,
    setSuccess,
    setUncertainHash,
    clearSubmittedTransaction: clearUncertainTransaction,
    setRecoveryRequired,
  })
  const { successHash, terminalConfirmed } = successfulTransactionState(success)
  return {
    pendingIntent,
    error,
    successHash,
    terminalConfirmed,
    uncertainHash,
    recoveryRequired,
    allowanceCooldown,
    clearUncertainTransaction: () => clearUncertainTransaction(),
    setError,
    submit,
  }
}
