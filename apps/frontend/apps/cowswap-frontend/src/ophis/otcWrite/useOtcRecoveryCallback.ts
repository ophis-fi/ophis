import { useCallback, useLayoutEffect, useRef } from 'react'

import { assertOtcReceipt } from './otcReceiptTracking.utils'
import { assertOtcTransactionHash } from './otcTransactionProof'
import { translateOtcWriteError } from './translateOtcWriteError'
import { finishSubmission, type OtcSubmitCallbackOptions } from './useOtcSubmitCallback'

import type { OtcTransactionReceipt } from './otcWrite.types'
import type { OtcSubmissionProof } from 'entities/otc'
import type { Hex } from 'viem'

type RecoveryOptions = Pick<
  OtcSubmitCallbackOptions,
  | 'wallet'
  | 'contextGeneration'
  | 'inFlightGeneration'
  | 'setPendingIntent'
  | 'setError'
  | 'setSuccess'
  | 'setRecoveryRequired'
  | 'onConfirmed'
  | 'beginAllowanceCooldown'
> & {
  canary: boolean
  uncertainHash: Hex | null
  proof: OtcSubmissionProof | undefined
  clearRecordedTransaction(verify: () => Promise<void>): Promise<void>
}

async function reconcile(
  options: RecoveryOptions,
  verifyOrigin: () => Promise<void>,
  suppliedHash?: Hex,
): Promise<void> {
  const {
    canary,
    wallet,
    uncertainHash,
    proof,
    clearRecordedTransaction,
    contextGeneration,
    inFlightGeneration,
    setPendingIntent,
    setError,
  } = options
  if (!canary) return uncertainHash ? clearRecordedTransaction(verifyOrigin) : undefined
  const hash = uncertainHash ?? suppliedHash
  const generation = contextGeneration.current
  if (!wallet || !hash || inFlightGeneration.current === generation) return
  inFlightGeneration.current = generation
  setPendingIntent('reconcile')
  setError(null)
  try {
    assertOtcTransactionHash(hash)
    await clearRecordedTransaction(async () => {
      await verifyOrigin()
      if (!proof) throw new Error('Ophis OTC transaction proof unavailable')
      const receipt = await wallet.waitForTransactionReceipt(hash, proof)
      assertOtcReceipt(hash, receipt)
      await verifyOrigin()
      if (contextGeneration.current !== generation) throw new Error('Ophis OTC action context changed')
      settleRecoveredReceipt(receipt, options)
    })
  } catch (caught) {
    if (contextGeneration.current === generation) setError(translateOtcWriteError(caught))
  } finally {
    finishSubmission(options, generation, () => contextGeneration.current === generation)
  }
}

function settleRecoveredReceipt(receipt: OtcTransactionReceipt, options: RecoveryOptions): void {
  if (receipt.status === 'success') {
    // ponytail: restored confirmations are terminal; persist action kind if in-place approval continuation is needed.
    options.setSuccess({ transactionHash: receipt.transactionHash, terminal: true })
    options.setRecoveryRequired(false)
    options.onConfirmed?.(receipt.transactionHash)
  } else {
    options.setError('The transaction reverted. Review the current order and allowance before retrying.')
    options.setRecoveryRequired(true)
  }
  options.beginAllowanceCooldown()
}

export function useOtcRecoveryCallback(
  options: RecoveryOptions,
): (verify: () => Promise<void>, hash?: Hex) => Promise<void> {
  const optionsRef = useRef(options)
  useLayoutEffect(() => {
    optionsRef.current = options
  }, [options])
  return useCallback((verify, hash) => reconcile(optionsRef.current, verify, hash), [])
}
