import { useCallback, useMemo } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { useWalletClient } from 'wagmi'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { useOtcWriteAuthorization } from './otcWriteAuthorization'
import { translateOtcWriteError } from './translateOtcWriteError'
import { useOtcControllerModel } from './useOtcControllerModel'
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
  canary?: boolean
  model: OtcActionModel
  error: string | null
  successHash: Hex | null
  uncertainHash: Hex | null
  signatureUncertain?: boolean
  allowance: bigint | null
  diagnostic: string | null
  clearUncertainTransaction(hash?: Hex): void
  runPrimary(): Promise<void>
}

function localDiagnostic(error: unknown): string | null {
  if (process.env.NODE_ENV === 'production' || !(error instanceof Error)) return null
  return error.message.slice(0, 240)
}

function useOtcRecoveryClear(
  submission: OtcSubmissionState,
  localForkResponse: OtcNetworkReads['localForkResponse'],
): (hash?: Hex) => Promise<void> {
  const { clearUncertainTransaction, setError } = submission
  return useCallback(
    async (hash?: Hex) => {
      try {
        await clearUncertainTransaction(async () => {
          const originalForkId = localForkResponse.data
          const currentForkId = await localForkResponse.mutate()
          if (!originalForkId || currentForkId !== originalForkId) throw new Error('Ophis OTC local fork changed')
        }, hash)
      } catch (caught) {
        setError(translateOtcWriteError(caught))
      }
    },
    [clearUncertainTransaction, localForkResponse, setError],
  )
}

export function useOtcActionController(
  definition: OtcActionDefinition,
  onConfirmed: OtcConfirmedCallback | undefined,
): OtcActionController {
  const { account, chainId } = useWalletInfo()
  const connectWallet = useToggleWalletModal()
  const { enabled, authorization } = useOtcWriteAuthorization()
  const canary = authorization.writeMode === 'canary'
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
  const model = useOtcControllerModel({ definition, network, submission, enabled, account, chainId })

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
  const { successHash, uncertainHash, signatureUncertain } = submission
  const clearUncertainTransaction = useOtcRecoveryClear(submission, network.localForkResponse)

  return useMemo(
    () => ({
      model,
      canary,
      error,
      successHash,
      uncertainHash,
      signatureUncertain,
      allowance,
      diagnostic,
      clearUncertainTransaction,
      runPrimary,
    }),
    [
      allowance,
      canary,
      clearUncertainTransaction,
      diagnostic,
      error,
      model,
      runPrimary,
      signatureUncertain,
      successHash,
      uncertainHash,
    ],
  )
}
