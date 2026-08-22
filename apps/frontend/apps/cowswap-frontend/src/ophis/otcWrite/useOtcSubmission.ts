import { useLayoutEffect, useMemo, useRef, useState } from 'react'

import { useOtcAllowanceCooldown } from './useOtcAllowanceCooldown'
import { useOtcSubmitCallback, type OtcSuccessfulTransaction } from './useOtcSubmitCallback'

import type { OtcWalletSubmitter, OtcWriteClient, OtcWriteIntent, OtcWriteRuntimeAuthorization } from './otcWrite.types'
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
  onConfirmed: (() => void) | undefined
}

export interface OtcSubmissionState {
  pendingIntent: OtcWriteIntent['kind'] | 'switch' | null
  error: string | null
  successHash: Hex | null
  terminalConfirmed: boolean
  uncertainHash: Hex | null
  recoveryRequired: boolean
  allowanceCooldown: boolean
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
  const [uncertainHash, setUncertainHash] = useState<Hex | null>(null)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const submissionContext = submissionContextKey(resetKey, account, authorization)
  const contextGeneration = useRef(0)
  const inFlightGeneration = useRef<number | null>(null)
  const [allowanceCooldown, beginAllowanceCooldown] = useOtcAllowanceCooldown(refreshAllowance, submissionContext)

  useLayoutEffect(() => {
    contextGeneration.current += 1
    inFlightGeneration.current = null
    setPendingIntent(null)
    setError(null)
    setSuccess(null)
    setUncertainHash(null)
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
    setRecoveryRequired,
  })
  const { successHash, terminalConfirmed } = successfulTransactionState(success)
  return useMemo(
    () => ({
      pendingIntent,
      error,
      successHash,
      terminalConfirmed,
      uncertainHash,
      recoveryRequired,
      allowanceCooldown,
      setError,
      submit,
    }),
    [allowanceCooldown, error, pendingIntent, recoveryRequired, submit, successHash, terminalConfirmed, uncertainHash],
  )
}
