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
import { useOtcRecoveryCallback } from './useOtcRecoveryCallback'
import { useOtcSubmitCallback, type OtcSuccessfulTransaction } from './useOtcSubmitCallback'

import type {
  OtcConfirmedCallback,
  OtcPendingIntent,
  OtcWalletSubmitter,
  OtcWriteClient,
  OtcWriteIntent,
  OtcWriteRuntimeAuthorization,
} from './otcWrite.types'
import type { OtcSubmissionProof } from 'entities/otc'
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
  pendingIntent: OtcPendingIntent | null
  error: string | null
  successHash: Hex | null
  terminalConfirmed: boolean
  uncertainHash: Hex | null
  signatureUncertain: boolean
  recoveryRequired: boolean
  allowanceCooldown: boolean
  clearUncertainTransaction(verifyOrigin: () => Promise<void>, hash?: Hex): Promise<void>
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
  proof: OtcSubmissionProof | undefined
  uncertainHash: Hex | null
  signatureUncertain: boolean
  setUncertainHash(hash: Hex | null, proof?: OtcSubmissionProof): void
  clearSubmittedTransaction(hash?: Hex | null): void
  clearUncertainTransaction(verifyOrigin: () => Promise<void>): Promise<void>
  withTransactionLock(operation: () => Promise<void>): Promise<void>
}

function useOtcUncertainTransaction(uncertainKey: string | null): OtcUncertainState {
  const [transactions, setTransactions] = useAtom(uncertainOtcTransactionsAtom)
  const coordinateTransaction = useSetAtom(coordinatedOtcTransactionAtom)
  const uncertainHash = uncertainKey ? (transactions[uncertainKey]?.transactionHash ?? null) : null
  const record = uncertainKey ? transactions[uncertainKey] : undefined
  const proof = record?.proof
  const attemptIdentity = JSON.stringify(record)
  const signatureUncertain = !!uncertainKey && transactions[uncertainKey]?.transactionHash === null
  const setUncertainHash = useCallback(
    (hash: Hex | null, proof?: OtcSubmissionProof) => {
      if (uncertainKey)
        setTransactions((current) => recordUncertainOtcTransaction(current, uncertainKey, hash, undefined, proof))
    },
    [setTransactions, uncertainKey],
  )
  const clearSubmittedTransaction = useCallback(
    (expectedHash?: Hex | null) => {
      if (uncertainKey) setTransactions((current) => removeUncertainOtcTransaction(current, uncertainKey, expectedHash))
    },
    [setTransactions, uncertainKey],
  )
  const clearUncertainTransaction = useCallback(
    (verifyOrigin: () => Promise<void>) =>
      coordinateTransaction(async (current) => {
        if (!uncertainKey || !attemptIdentity || JSON.stringify(current[uncertainKey]) !== attemptIdentity) return
        await verifyOrigin()
        setTransactions((latest) =>
          JSON.stringify(latest[uncertainKey]) === attemptIdentity
            ? removeUncertainOtcTransaction(latest, uncertainKey, uncertainHash, current[uncertainKey].attemptId)
            : latest,
        )
      }),
    [attemptIdentity, coordinateTransaction, setTransactions, uncertainHash, uncertainKey],
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
      proof,
      signatureUncertain,
      setUncertainHash,
      clearSubmittedTransaction,
      clearUncertainTransaction,
      withTransactionLock,
    }),
    [
      clearSubmittedTransaction,
      clearUncertainTransaction,
      setUncertainHash,
      uncertainHash,
      proof,
      signatureUncertain,
      withTransactionLock,
    ],
  )
}

export function useOtcSubmission(options: OtcSubmissionOptions): OtcSubmissionState {
  const { writeClient, wallet, authorization, resetKey, account, refreshAllowance, onConfirmed } = options
  const [pendingIntent, setPendingIntent] = useState<OtcPendingIntent | null>(null)
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
    ...options,
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
  const clearUncertainTransaction = useOtcRecoveryCallback({
    canary: authorization.writeMode === 'canary',
    wallet,
    uncertainHash: uncertainty.uncertainHash,
    proof: uncertainty.proof,
    clearRecordedTransaction: uncertainty.clearUncertainTransaction,
    contextGeneration,
    inFlightGeneration,
    setPendingIntent,
    setError,
    setSuccess,
    setRecoveryRequired,
    onConfirmed,
    beginAllowanceCooldown,
  })
  return useMemo(
    () => ({
      pendingIntent,
      error,
      ...successfulTransactionState(success),
      uncertainHash: uncertainty.uncertainHash,
      signatureUncertain: uncertainty.signatureUncertain,
      recoveryRequired,
      allowanceCooldown,
      clearUncertainTransaction,
      setError,
      submit,
    }),
    [
      allowanceCooldown,
      clearUncertainTransaction,
      error,
      pendingIntent,
      recoveryRequired,
      submit,
      success,
      uncertainty,
    ],
  )
}
