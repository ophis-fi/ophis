import { useAtom, useSetAtom } from 'jotai'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'

import {
  coordinatedOtcTransactionAtom,
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
  clearUncertainTransaction(verifyOrigin: () => Promise<void>): Promise<void>
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

interface OtcUncertainState {
  uncertainHash: Hex | null
  setUncertainHash(hash: Hex): void
  clearSubmittedTransaction(hash?: Hex): void
  clearUncertainTransaction(verifyOrigin: () => Promise<void>): Promise<void>
  withTransactionLock(operation: () => Promise<void>): Promise<void>
}

function useOtcUncertainTransaction(uncertainKey: string | null): OtcUncertainState {
  const [transactions, setTransactions] = useAtom(uncertainOtcTransactionsAtom)
  const coordinateTransaction = useSetAtom(coordinatedOtcTransactionAtom)
  const uncertainHash = uncertainKey ? (transactions[uncertainKey]?.transactionHash ?? null) : null
  const setUncertainHash = useCallback(
    (hash: Hex) => {
      if (uncertainKey) setTransactions((current) => recordUncertainOtcTransaction(current, uncertainKey, hash))
    },
    [setTransactions, uncertainKey],
  )
  const clearSubmittedTransaction = useCallback(
    (expectedHash?: Hex) => {
      if (uncertainKey) setTransactions((current) => removeUncertainOtcTransaction(current, uncertainKey, expectedHash))
    },
    [setTransactions, uncertainKey],
  )
  const clearUncertainTransaction = useCallback(
    (verifyOrigin: () => Promise<void>) =>
      coordinateTransaction(async () => {
        if (!uncertainHash) return
        await verifyOrigin()
        clearSubmittedTransaction(uncertainHash)
      }),
    [clearSubmittedTransaction, coordinateTransaction, uncertainHash],
  )
  const withTransactionLock = useCallback(
    (operation: () => Promise<void>) =>
      coordinateTransaction(async (current) => {
        if (!uncertainKey) throw new Error('Ophis OTC wallet account unavailable')
        if (current[uncertainKey]) throw new Error('Ophis OTC transaction confirmation unavailable')
        await operation()
      }),
    [coordinateTransaction, uncertainKey],
  )
  return useMemo(
    () => ({
      uncertainHash,
      setUncertainHash,
      clearSubmittedTransaction,
      clearUncertainTransaction,
      withTransactionLock,
    }),
    [clearSubmittedTransaction, clearUncertainTransaction, setUncertainHash, uncertainHash, withTransactionLock],
  )
}

export function useOtcSubmission(options: OtcSubmissionOptions): OtcSubmissionState {
  const { writeClient, wallet, authorization, resetKey, account, requiredAllowance, refreshAllowance, onConfirmed } =
    options
  const [pendingIntent, setPendingIntent] = useState<OtcWriteIntent['kind'] | 'switch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<OtcSuccessfulTransaction | null>(null)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const submissionContext = submissionContextKey(resetKey, account, authorization)
  const uncertainKey = account ? `${getAddressKey(account)}\u0000${resetKey}` : null
  const uncertainty = useOtcUncertainTransaction(uncertainKey)
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
    setUncertainHash: uncertainty.setUncertainHash,
    clearSubmittedTransaction: uncertainty.clearSubmittedTransaction,
    setRecoveryRequired,
    withTransactionLock: uncertainty.withTransactionLock,
  })
  return useMemo(
    () => ({
      pendingIntent,
      error,
      ...successfulTransactionState(success),
      uncertainHash: uncertainty.uncertainHash,
      recoveryRequired,
      allowanceCooldown,
      clearUncertainTransaction: uncertainty.clearUncertainTransaction,
      setError,
      submit,
    }),
    [allowanceCooldown, error, pendingIntent, recoveryRequired, submit, success, uncertainty],
  )
}
