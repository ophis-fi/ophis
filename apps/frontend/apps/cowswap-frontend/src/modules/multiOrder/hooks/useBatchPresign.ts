import { useCallback, useState } from 'react'

import { useWalletClient } from 'wagmi'

import { encodeFunctionData } from 'viem'

import { buildSetPreSignatureCalls, detectAtomicBatchCapability, Eip5792Capabilities, SET_PRE_SIGNATURE_ABI } from '../pure/capabilities'

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

  const detect = useCallback(async (): Promise<boolean> => {
    if (!walletClient) {
      setCapable(false)
      return false
    }
    setIsDetecting(true)
    try {
      // viem EIP-5792 action; guarded so a wallet without it degrades to stepped.
      const getCapabilities = (walletClient as { getCapabilities?: () => Promise<Eip5792Capabilities> }).getCapabilities
      const caps = typeof getCapabilities === 'function' ? await getCapabilities.call(walletClient) : undefined
      const result = detectAtomicBatchCapability(caps ?? undefined, chainId)
      setCapable(result)
      return result
    } catch {
      setCapable(false)
      return false
    } finally {
      setIsDetecting(false)
    }
  }, [walletClient, chainId])

  const presignBatch = useCallback(
    async (orderUids: readonly string[], settlement: string): Promise<string> => {
      if (!walletClient) throw new Error('useBatchPresign: no connected wallet client')
      const calls = buildSetPreSignatureCalls(orderUids, settlement, (uid) =>
        encodeFunctionData({ abi: SET_PRE_SIGNATURE_ABI, functionName: 'setPreSignature', args: [uid as `0x${string}`, true] }),
      )
      const sendCalls = (walletClient as { sendCalls?: (args: unknown) => Promise<{ id: string } | string> }).sendCalls
      if (typeof sendCalls !== 'function') {
        throw new Error('useBatchPresign: wallet client does not support wallet_sendCalls')
      }
      const res = await sendCalls.call(walletClient, {
        calls: calls.map((c) => ({ to: c.to as `0x${string}`, data: c.data as `0x${string}`, value: BigInt(c.value) })),
      })
      return typeof res === 'string' ? res : res.id
    },
    [walletClient],
  )

  return { capable, isDetecting, detect, presignBatch }
}
