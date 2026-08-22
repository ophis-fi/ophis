import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { withOtcTimeout } from 'ophis/otc'

import { submitOtcTransaction } from './prepareOtcTransaction'
import { translateOtcWriteError } from './translateOtcWriteError'
import { useOtcAllowanceCooldown } from './useOtcAllowanceCooldown'

import type { OtcWalletSubmitter, OtcWriteClient, OtcWriteIntent, OtcWriteRuntimeAuthorization } from './otcWrite.types'
import type { Address, Hex } from 'viem'

const POST_RECEIPT_ALLOWANCE_TIMEOUT_MS = 5_000

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
  recoveryRequired: boolean
  allowanceCooldown: boolean
  setError(error: string | null): void
  submit(intent: OtcWriteIntent, execution: boolean): Promise<void>
}

async function hasRecoveryAllowance(
  refreshAllowance: RefreshOtcAllowance,
  execution: boolean,
  requiredAllowance: bigint | null | undefined,
): Promise<boolean> {
  const refreshed = await withOtcTimeout(
    refreshAllowance(),
    POST_RECEIPT_ALLOWANCE_TIMEOUT_MS,
    'Ophis OTC allowance refresh timed out',
  ).catch(() => undefined)
  if (!execution || requiredAllowance === null || requiredAllowance === undefined) return false
  // A failed re-read must not erase recovery state. Allowance polling keeps the
  // action unavailable until it succeeds; if it later observes a positive
  // balance, the one-button model offers revocation instead of execution.
  return refreshed ? refreshed.allowance > 0n : true
}

interface OtcSubmissionSuccessResult {
  beginCooldown: boolean
  clearRecovery: boolean
  confirmed: boolean
}

async function settleSuccessfulSubmission(
  intent: OtcWriteIntent,
  requiredAllowance: bigint | null | undefined,
  refreshAllowance: RefreshOtcAllowance,
  isCurrentContext: () => boolean,
): Promise<OtcSubmissionSuccessResult | null> {
  const allowanceIntent = /^(approve|revoke)-/.test(intent.kind)
  const refreshRequired = allowanceIntent || (requiredAllowance !== null && requiredAllowance !== undefined)
  if (!isCurrentContext()) return null
  if (refreshRequired) {
    await withOtcTimeout(
      refreshAllowance(),
      POST_RECEIPT_ALLOWANCE_TIMEOUT_MS,
      'Ophis OTC allowance refresh timed out',
    ).catch(() => undefined)
  }
  if (!isCurrentContext()) return null
  return {
    beginCooldown: refreshRequired,
    clearRecovery: !allowanceIntent || intent.kind.startsWith('revoke-'),
    confirmed: !allowanceIntent,
  }
}

async function settleFailedSubmission(
  caught: unknown,
  execution: boolean,
  requiredAllowance: bigint | null | undefined,
  refreshAllowance: RefreshOtcAllowance,
  isCurrentContext: () => boolean,
): Promise<{ error: string; recoveryRequired: boolean } | null> {
  if (!isCurrentContext()) return null
  const recoveryRequired = await hasRecoveryAllowance(refreshAllowance, execution, requiredAllowance)
  if (!isCurrentContext()) return null
  return { error: translateOtcWriteError(caught), recoveryRequired }
}

function applySuccessfulSubmission(
  result: OtcSubmissionSuccessResult | null,
  transactionHash: Hex,
  setSuccessHash: (hash: Hex) => void,
  setRecoveryRequired: (required: boolean) => void,
  beginAllowanceCooldown: () => void,
  onConfirmed: (() => void) | undefined,
): boolean {
  if (!result) return false
  setSuccessHash(transactionHash)
  if (result.clearRecovery) setRecoveryRequired(false)
  if (result.beginCooldown) beginAllowanceCooldown()
  if (result.confirmed) onConfirmed?.()
  return true
}

function applyFailedSubmission(
  result: { error: string; recoveryRequired: boolean } | null,
  setError: (error: string) => void,
  setRecoveryRequired: (required: boolean) => void,
): boolean {
  if (!result) return false
  setError(result.error)
  setRecoveryRequired(result.recoveryRequired)
  return true
}

function finishSubmission(
  inFlightGeneration: { current: number | null },
  generation: number,
  isCurrentContext: () => boolean,
  setPendingIntent: (intent: null) => void,
): void {
  if (inFlightGeneration.current === generation) inFlightGeneration.current = null
  if (isCurrentContext()) setPendingIntent(null)
}

function submissionContextKey(
  resetKey: string,
  account: Address | undefined,
  authorization: OtcWriteRuntimeAuthorization,
): string {
  const { readFlag, writeFlag, isLocal, writeMode } = authorization
  return [resetKey, account ?? '', readFlag, writeFlag, isLocal, writeMode ?? ''].join('\u0000')
}

export function useOtcSubmission(options: OtcSubmissionOptions): OtcSubmissionState {
  const { writeClient, wallet, authorization, resetKey, account, requiredAllowance, refreshAllowance, onConfirmed } =
    options
  const [pendingIntent, setPendingIntent] = useState<OtcWriteIntent['kind'] | 'switch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successHash, setSuccessHash] = useState<Hex | null>(null)
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
    setSuccessHash(null)
    setRecoveryRequired(false)
    return () => {
      contextGeneration.current += 1
      inFlightGeneration.current = null
    }
  }, [submissionContext, wallet, writeClient])

  const submit = useCallback(
    async (intent: OtcWriteIntent, execution: boolean) => {
      const generation = contextGeneration.current
      const isCurrentContext = (): boolean => contextGeneration.current === generation
      if (inFlightGeneration.current === generation) return
      if (!writeClient || !wallet) {
        setError('Wallet access is still loading. Try again in a moment.')
        return
      }
      inFlightGeneration.current = generation
      setPendingIntent(intent.kind)
      setError(null)
      setSuccessHash(null)
      try {
        const receipt = await submitOtcTransaction(
          writeClient,
          wallet,
          intent,
          authorization,
          undefined,
          isCurrentContext,
        )
        const result = await settleSuccessfulSubmission(intent, requiredAllowance, refreshAllowance, isCurrentContext)
        if (
          !applySuccessfulSubmission(
            result,
            receipt.transactionHash,
            setSuccessHash,
            setRecoveryRequired,
            beginAllowanceCooldown,
            onConfirmed,
          )
        )
          return
      } catch (caught) {
        const result = await settleFailedSubmission(
          caught,
          execution,
          requiredAllowance,
          refreshAllowance,
          isCurrentContext,
        )
        if (!applyFailedSubmission(result, setError, setRecoveryRequired)) return
      } finally {
        finishSubmission(inFlightGeneration, generation, isCurrentContext, setPendingIntent)
      }
    },
    [authorization, beginAllowanceCooldown, onConfirmed, refreshAllowance, requiredAllowance, wallet, writeClient],
  )
  return useMemo(
    () => ({ pendingIntent, error, successHash, recoveryRequired, allowanceCooldown, setError, submit }),
    [allowanceCooldown, error, pendingIntent, recoveryRequired, submit, successHash],
  )
}
