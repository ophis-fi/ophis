import { useCallback, useLayoutEffect, useRef } from 'react'

import { OtcReceiptTrackingError } from './otcReceiptTrackingError'
import { withOtcAllowanceRefreshTimeout } from './otcWriteTimeouts'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { translateOtcWriteError } from './translateOtcWriteError'

import type {
  OtcConfirmedCallback,
  OtcWalletSubmitter,
  OtcWriteClient,
  OtcWriteIntent,
  OtcWriteRuntimeAuthorization,
} from './otcWrite.types'
import type { RefreshOtcAllowance } from './useOtcSubmission'
import type { Hex } from 'viem'

export interface OtcSuccessfulTransaction {
  transactionHash: Hex
  terminal: boolean
}

interface OtcSubmitCallbackOptions {
  writeClient: OtcWriteClient | null
  wallet: OtcWalletSubmitter | null
  authorization: OtcWriteRuntimeAuthorization
  requiredAllowance: bigint | null | undefined
  refreshAllowance: RefreshOtcAllowance
  contextGeneration: { current: number }
  inFlightGeneration: { current: number | null }
  beginAllowanceCooldown: () => void
  onConfirmed: OtcConfirmedCallback | undefined
  setPendingIntent: (intent: OtcWriteIntent['kind'] | null) => void
  setError: (error: string | null) => void
  setSuccess: (success: OtcSuccessfulTransaction | null) => void
  setUncertainHash: (hash: Hex) => void
  clearSubmittedTransaction: (hash: Hex) => void
  setRecoveryRequired: (required: boolean) => void
}

async function hasRecoveryAllowance(
  refreshAllowance: RefreshOtcAllowance,
  execution: boolean,
  requiredAllowance: bigint | null | undefined,
): Promise<boolean> {
  const refreshed = await withOtcAllowanceRefreshTimeout(refreshAllowance).catch(() => undefined)
  if (!execution || requiredAllowance === null || requiredAllowance === undefined) return false
  // Keep recovery active until a successful re-read proves no allowance remains.
  return refreshed ? refreshed.allowance > 0n : true
}

async function settleSuccessfulSubmission(
  intent: OtcWriteIntent,
  options: Pick<OtcSubmitCallbackOptions, 'requiredAllowance' | 'refreshAllowance'>,
  isCurrentContext: () => boolean,
): Promise<{ beginCooldown: boolean; confirmed: boolean } | null> {
  const allowanceIntent = /^(approve|revoke)-/.test(intent.kind)
  const refreshRequired =
    allowanceIntent || (options.requiredAllowance !== null && options.requiredAllowance !== undefined)
  if (!isCurrentContext()) return null
  if (refreshRequired) {
    await withOtcAllowanceRefreshTimeout(options.refreshAllowance).catch(() => undefined)
  }
  if (!isCurrentContext()) return null
  return { beginCooldown: refreshRequired, confirmed: !allowanceIntent }
}

async function settleFailedSubmission(
  caught: unknown,
  execution: boolean,
  options: Pick<OtcSubmitCallbackOptions, 'requiredAllowance' | 'refreshAllowance'>,
  isCurrentContext: () => boolean,
): Promise<{ error: string; recoveryRequired: boolean } | null> {
  if (!isCurrentContext()) return null
  const recoveryRequired = await hasRecoveryAllowance(options.refreshAllowance, execution, options.requiredAllowance)
  if (!isCurrentContext()) return null
  return { error: translateOtcWriteError(caught), recoveryRequired }
}

function captureSubmissionContext(contextGeneration: { current: number }): {
  generation: number
  isCurrentContext: () => boolean
} {
  const generation = contextGeneration.current
  return { generation, isCurrentContext: () => contextGeneration.current === generation }
}

function finishSubmission(
  options: Pick<OtcSubmitCallbackOptions, 'inFlightGeneration' | 'setPendingIntent'>,
  generation: number,
  isCurrentContext: () => boolean,
): void {
  if (options.inFlightGeneration.current === generation) options.inFlightGeneration.current = null
  if (isCurrentContext()) options.setPendingIntent(null)
}

function applyUncertainSubmission(
  caught: unknown,
  setUncertainHash: OtcSubmitCallbackOptions['setUncertainHash'],
): boolean {
  if (!(caught instanceof OtcReceiptTrackingError)) return false
  setUncertainHash(caught.transactionHash)
  return true
}

function applySuccessfulSubmission(
  result: Awaited<ReturnType<typeof settleSuccessfulSubmission>>,
  transactionHash: Hex,
  options: OtcSubmitCallbackOptions,
): boolean {
  if (!result) return false
  options.setSuccess({ transactionHash, terminal: result.confirmed })
  options.setRecoveryRequired(false)
  if (result.beginCooldown) options.beginAllowanceCooldown()
  if (result.confirmed) options.onConfirmed?.(transactionHash)
  return true
}

function applyFailedSubmission(
  result: Awaited<ReturnType<typeof settleFailedSubmission>>,
  options: OtcSubmitCallbackOptions,
): boolean {
  if (!result) return false
  options.setError(result.error)
  options.setRecoveryRequired(result.recoveryRequired)
  return true
}

async function runOtcSubmission(
  options: OtcSubmitCallbackOptions,
  intent: OtcWriteIntent,
  execution: boolean,
): Promise<void> {
  const { generation, isCurrentContext } = captureSubmissionContext(options.contextGeneration)
  if (options.inFlightGeneration.current === generation) return
  if (!options.writeClient || !options.wallet) {
    options.setError('Wallet access is still loading. Try again in a moment.')
    return
  }
  options.inFlightGeneration.current = generation
  options.setPendingIntent(intent.kind)
  options.setError(null)
  options.setSuccess(null)
  let broadcastHash: Hex | null = null
  try {
    const receipt = await submitOtcTransaction(
      options.writeClient,
      options.wallet,
      intent,
      options.authorization,
      undefined,
      isCurrentContext,
      (hash) => {
        broadcastHash = hash
        options.setUncertainHash(hash)
      },
    )
    if (broadcastHash) options.clearSubmittedTransaction(broadcastHash)
    const result = await settleSuccessfulSubmission(intent, options, isCurrentContext)
    if (!applySuccessfulSubmission(result, receipt.transactionHash, options)) return
  } catch (caught) {
    if (applyUncertainSubmission(caught, options.setUncertainHash)) return
    if (broadcastHash) options.clearSubmittedTransaction(broadcastHash)
    const result = await settleFailedSubmission(caught, execution, options, isCurrentContext)
    if (!applyFailedSubmission(result, options)) return
  } finally {
    finishSubmission(options, generation, isCurrentContext)
  }
}

export function useOtcSubmitCallback(
  options: OtcSubmitCallbackOptions,
): (intent: OtcWriteIntent, execution: boolean) => Promise<void> {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  return useCallback((intent, execution) => runOtcSubmission(optionsRef.current, intent, execution), [])
}
