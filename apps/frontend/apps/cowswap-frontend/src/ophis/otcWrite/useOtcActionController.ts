import { useCallback, useMemo } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useWalletClient } from 'wagmi'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { useOtcWriteAuthorization } from './otcWriteAuthorization'
import { translateOtcWriteError } from './translateOtcWriteError'
import { useOtcActionModel } from './useOtcActionModel'
import { useOtcNetworkReads, type OtcNetworkReads } from './useOtcNetworkReads'
import { useOtcSubmission, type OtcSubmissionState } from './useOtcSubmission'

import type { OtcActionModel } from './otcActionModel'
import type {
  OtcApproveCreateIntent,
  OtcApproveFillIntent,
  OtcConfirmedCallback,
  OtcRevokeCreateIntent,
  OtcRevokeFillIntent,
  OtcWriteIntent,
} from './otcWrite.types'
import type { Address, Hex } from 'viem'

type ApprovalIntent = OtcApproveCreateIntent | OtcApproveFillIntent
type RevokeIntent = OtcRevokeCreateIntent | OtcRevokeFillIntent

export interface OtcActionDefinition {
  executeLabel: string
  unavailableLabel?: string
  ready: boolean
  reviewed: boolean
  resetKey: string
  executeIntent: OtcWriteIntent | null
  approvalIntent?: ApprovalIntent | null
  revokeIntent?: RevokeIntent | null
  allowanceToken?: Address | null
  allowanceTokenDecimals?: number
  allowanceTokenSymbol?: string
  requiredAllowance?: bigint | null
}

export interface OtcActionController {
  model: OtcActionModel
  error: string | null
  successHash: Hex | null
  uncertainHash: Hex | null
  allowance: bigint | null
  diagnostic: string | null
  clearUncertainTransaction(): void
  runPrimary(): Promise<void>
}

function localForkStatus(
  account: Address | undefined,
  chainId: number,
  data: Hex | null | undefined,
  error: unknown,
): boolean | null {
  if (!account || chainId !== SupportedChainId.MAINNET) return null
  if (error) return false
  return data === undefined ? null : data !== null
}

function localDiagnostic(error: unknown): string | null {
  if (process.env.NODE_ENV === 'production' || !(error instanceof Error)) return null
  return error.message.slice(0, 240)
}

function useOtcRecoveryClear(
  submission: OtcSubmissionState,
  localForkResponse: OtcNetworkReads['localForkResponse'],
): () => Promise<void> {
  const { clearUncertainTransaction, setError } = submission
  return useCallback(async () => {
    try {
      await clearUncertainTransaction(async () => {
        const originalForkId = localForkResponse.data
        const currentForkId = await localForkResponse.mutate()
        if (!originalForkId || currentForkId !== originalForkId) throw new Error('Ophis OTC local fork changed')
      })
    } catch (caught) {
      setError(translateOtcWriteError(caught))
    }
  }, [clearUncertainTransaction, localForkResponse, setError])
}

export function useOtcActionController(
  definition: OtcActionDefinition,
  onConfirmed: OtcConfirmedCallback | undefined,
): OtcActionController {
  const { account, chainId } = useWalletInfo()
  const connectWallet = useToggleWalletModal()
  const { enabled, authorization } = useOtcWriteAuthorization()
  const { data: walletClient } = useWalletClient()
  const network = useOtcNetworkReads(enabled, account, chainId, walletClient, definition.allowanceToken ?? null)
  const refreshAllowance = useCallback(() => network.allowanceResponse.mutate(), [network.allowanceResponse])
  const submission = useOtcSubmission({
    writeClient: network.writeClient,
    wallet: network.wallet,
    authorization,
    resetKey: `${network.localForkResponse.data ?? 'unverified'}\u0000${definition.resetKey}`,
    account,
    requiredAllowance: definition.requiredAllowance,
    refreshAllowance,
    onConfirmed,
  })
  const allowance = network.allowanceResponse.data?.allowance ?? null
  const localForkVerified = localForkStatus(
    account,
    chainId,
    network.localForkResponse.data,
    network.localForkResponse.error,
  )
  const model = useOtcActionModel({
    enabled,
    connected: !!account,
    correctChain: chainId === SupportedChainId.MAINNET,
    localForkVerified,
    ready: definition.ready,
    reviewed: definition.reviewed,
    allowance,
    allowanceFailed: !!network.allowanceResponse.error,
    requiredAllowance: definition.requiredAllowance ?? null,
    recoveryRequired: submission.recoveryRequired,
    allowanceCooldown: submission.allowanceCooldown,
    receiptConfirmed: submission.terminalConfirmed,
    receiptUncertain: submission.uncertainHash !== null,
    pendingIntent: submission.pendingIntent,
    executeLabel: definition.executeLabel,
    unavailableLabel: definition.unavailableLabel ?? 'Complete the order terms',
  })

  const runPrimary = useCallback(async () => {
    switch (model.action) {
      case 'connect':
        connectWallet()
        return
      case 'switch':
        submission.setError(
          'Select your chain-id-1 Anvil fork network in the wallet. Automatic switching to real Ethereum is disabled.',
        )
        return
      case 'approve':
        if (definition.approvalIntent) await submission.submit(definition.approvalIntent, false)
        return
      case 'revoke':
        if (definition.revokeIntent) await submission.submit(definition.revokeIntent, false)
        return
      case 'execute':
        if (definition.executeIntent) await submission.submit(definition.executeIntent, true)
        return
      case 'unavailable':
        return
    }
  }, [connectWallet, definition, model.action, submission])

  const error =
    submission.error ??
    (network.allowanceResponse.error ? translateOtcWriteError(network.allowanceResponse.error) : null)
  const diagnostic = localDiagnostic(network.allowanceResponse.error)
  const { successHash, uncertainHash } = submission
  const clearUncertainTransaction = useOtcRecoveryClear(submission, network.localForkResponse)

  return useMemo(
    () => ({ model, error, successHash, uncertainHash, allowance, diagnostic, clearUncertainTransaction, runPrimary }),
    [allowance, clearUncertainTransaction, diagnostic, error, model, runPrimary, successHash, uncertainHash],
  )
}
