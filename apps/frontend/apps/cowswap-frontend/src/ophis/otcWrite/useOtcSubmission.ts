import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { OTC_FILL_DEADLINE_WINDOW_SECONDS } from './buildOtcTransaction'
import { submitOtcTransaction } from './prepareOtcTransaction'
import { translateOtcWriteError } from './translateOtcWriteError'
import { useOtcAllowanceCooldown } from './useOtcAllowanceCooldown'

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
  recoveryRequired: boolean
  allowanceCooldown: boolean
  setError(error: string | null): void
  submit(intent: OtcWriteIntent, execution: boolean): Promise<void>
}

function withFreshDeadline(intent: OtcWriteIntent, nowSeconds: bigint): OtcWriteIntent {
  return intent.kind === 'fill' ? { ...intent, deadline: nowSeconds + OTC_FILL_DEADLINE_WINDOW_SECONDS } : intent
}

async function hasRecoveryAllowance(
  refreshAllowance: RefreshOtcAllowance,
  execution: boolean,
  requiredAllowance: bigint | null | undefined,
): Promise<boolean> {
  const refreshed = await refreshAllowance().catch(() => undefined)
  if (!execution || requiredAllowance === null || requiredAllowance === undefined) return false
  // A failed re-read must not erase recovery state. Allowance polling keeps the
  // action unavailable until it succeeds; if it later observes a positive
  // balance, the one-button model offers revocation instead of execution.
  return refreshed ? refreshed.allowance > 0n : true
}

export function useOtcSubmission(options: OtcSubmissionOptions): OtcSubmissionState {
  const { writeClient, wallet, authorization, resetKey, account, requiredAllowance, refreshAllowance, onConfirmed } =
    options
  const [pendingIntent, setPendingIntent] = useState<OtcWriteIntent['kind'] | 'switch' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [successHash, setSuccessHash] = useState<Hex | null>(null)
  const [recoveryRequired, setRecoveryRequired] = useState(false)
  const inFlight = useRef(false)
  const [allowanceCooldown, beginAllowanceCooldown] = useOtcAllowanceCooldown(refreshAllowance)

  useEffect(() => {
    setError(null)
    setSuccessHash(null)
    setRecoveryRequired(false)
  }, [resetKey, account])

  const submit = useCallback(
    async (intent: OtcWriteIntent, execution: boolean) => {
      if (inFlight.current) return
      if (!writeClient || !wallet) {
        setError('Wallet access is still loading. Try again in a moment.')
        return
      }
      inFlight.current = true
      const nowSeconds = BigInt(Math.floor(Date.now() / 1_000))
      const currentIntent = withFreshDeadline(intent, nowSeconds)
      setPendingIntent(currentIntent.kind)
      setError(null)
      setSuccessHash(null)
      try {
        const receipt = await submitOtcTransaction(writeClient, wallet, currentIntent, authorization, nowSeconds)
        setSuccessHash(receipt.transactionHash)
        if (/^(approve|revoke)-/.test(currentIntent.kind)) {
          await refreshAllowance().catch(() => undefined)
          if (currentIntent.kind.startsWith('revoke-')) setRecoveryRequired(false)
          beginAllowanceCooldown()
        } else {
          setRecoveryRequired(false)
          if (requiredAllowance !== null && requiredAllowance !== undefined) {
            await refreshAllowance().catch(() => undefined)
            beginAllowanceCooldown()
          }
          onConfirmed?.()
        }
      } catch (caught) {
        setError(translateOtcWriteError(caught))
        setRecoveryRequired(await hasRecoveryAllowance(refreshAllowance, execution, requiredAllowance))
      } finally {
        inFlight.current = false
        setPendingIntent(null)
      }
    },
    [authorization, beginAllowanceCooldown, onConfirmed, refreshAllowance, requiredAllowance, wallet, writeClient],
  )
  return useMemo(
    () => ({ pendingIntent, error, successHash, recoveryRequired, allowanceCooldown, setError, submit }),
    [allowanceCooldown, error, pendingIntent, recoveryRequired, submit, successHash],
  )
}
