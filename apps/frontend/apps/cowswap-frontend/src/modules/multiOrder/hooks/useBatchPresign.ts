import { useCallback, useEffect, useRef, useState } from 'react'

import { getWalletCallsId } from '@cowprotocol/wallet'

import { encodeFunctionData } from 'viem'
import { useWalletClient } from 'wagmi'

import {
  buildSetPreSignatureCalls,
  detectAtomicBatchCapability,
  SET_PRE_SIGNATURE_ABI,
  type Eip5792Capabilities,
} from '../pure/capabilities'

/**
 * Smart-account (EIP-5792) basket tier: pre-sign every leg in ONE
 * `wallet_sendCalls` batch of `setPreSignature(orderUid, true)` calls to the
 * settlement contract (presign signing scheme). Best-effort same-batch, NEVER
 * atomic: the legs still settle as independent CoW orders, so per-leg status and
 * cancel-of-unfilled remain in force. Falls back to the stepped tier whenever
 * the connected wallet does not report atomic-batch support.
 *
 * Capability parsing and call assembly live in pure/capabilities.ts (unit
 * tested); this hook only binds them to the viem wallet client.
 */
export interface UseBatchPresignResult {
  /** Detected atomic-batch support on this chain (undefined until detect() runs). */
  readonly capable: boolean | undefined
  readonly isDetecting: boolean
  /** Query wallet_getCapabilities and cache the result. Returns the capability. */
  readonly detect: () => Promise<boolean>
  /** Pre-sign the given order uids in one batch. Resolves with the batch id. */
  readonly presignBatch: (orderUids: readonly string[], settlement: string) => Promise<string>
}

export function useBatchPresign(chainId: number): UseBatchPresignResult {
  const { data: walletClient } = useWalletClient()
  const [capable, setCapable] = useState<boolean | undefined>(undefined)
  const [isDetecting, setIsDetecting] = useState(false)
  // Monotonic detect run id: a capability detection is only applied if it is the
  // latest run, so a slow detection that resolves AFTER the wallet/chain changed
  // cannot overwrite the reset state with a stale answer.
  const detectRunRef = useRef(0)

  // Capability is per (wallet account + chain). Reset it whenever either changes
  // so a batch capability detected for one account/chain never leaks into another
  // (the walletClient identity changes on account or chain switch in wagmi). This
  // also invalidates any in-flight detect via the run id.
  useEffect(() => {
    detectRunRef.current += 1
    setCapable(undefined)
    setIsDetecting(false)
  }, [walletClient, chainId])

  const detect = useCallback(async (): Promise<boolean> => {
    if (!walletClient) {
      setCapable(false)
      return false
    }
    const runId = ++detectRunRef.current
    setIsDetecting(true)
    try {
      // viem EIP-5792 action; guarded so a wallet without it degrades to stepped.
      const getCapabilities = (walletClient as { getCapabilities?: () => Promise<Eip5792Capabilities> }).getCapabilities
      const caps = typeof getCapabilities === 'function' ? await getCapabilities.call(walletClient) : undefined
      const result = detectAtomicBatchCapability(caps ?? undefined, chainId)
      // Ignore a completion from a superseded run (wallet/chain changed meanwhile).
      if (runId !== detectRunRef.current) return false
      setCapable(result)
      return result
    } catch {
      if (runId === detectRunRef.current) setCapable(false)
      return false
    } finally {
      if (runId === detectRunRef.current) setIsDetecting(false)
    }
  }, [walletClient, chainId])

  const presignBatch = useCallback(
    async (orderUids: readonly string[], settlement: string): Promise<string> => {
      if (!walletClient) throw new Error('useBatchPresign: no connected wallet client')
      if (capable !== true) throw new Error('useBatchPresign: batch capability has not been confirmed')
      const calls = buildSetPreSignatureCalls(orderUids, settlement, (uid) =>
        encodeFunctionData({
          abi: SET_PRE_SIGNATURE_ABI,
          functionName: 'setPreSignature',
          args: [uid as `0x${string}`, true],
        }),
      )
      const sendCalls = (walletClient as { sendCalls?: (args: unknown) => Promise<{ id: string } | string> }).sendCalls
      if (typeof sendCalls !== 'function') {
        setCapable(false)
        throw new Error('useBatchPresign: wallet client does not support wallet_sendCalls')
      }
      try {
        const result = await sendCalls.call(walletClient, {
          calls: calls.map((call) => ({
            to: call.to as `0x${string}`,
            data: call.data as `0x${string}`,
            value: BigInt(call.value),
          })),
        })

        return getWalletCallsId(result)
      } catch (error) {
        // Disable the optional batch tier after any rejected or malformed
        // response. The caller may offer the stepped tier on the next explicit
        // user action, but must never replay an uncertain batch automatically.
        setCapable(false)
        throw error
      }
    },
    [walletClient, capable],
  )

  return { capable, isDetecting, detect, presignBatch }
}
