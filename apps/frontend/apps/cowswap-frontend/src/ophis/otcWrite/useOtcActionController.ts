import { useCallback, useMemo } from 'react'

import { getAddressKey } from '@cowprotocol/cow-sdk'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useWalletClient } from 'wagmi'

import { useToggleWalletModal } from 'legacy/state/application/hooks'

import { isOtcCanaryAccount } from './otcCanaryPolicy'
import { useOtcWriteAuthorization } from './otcWriteAuthorization'
import { translateOtcWriteError } from './translateOtcWriteError'
import { useOtcControllerModel } from './useOtcControllerModel'
import { useOtcNetworkReads, type OtcNetworkReads } from './useOtcNetworkReads'
import { useOtcNetworkSwitch } from './useOtcNetworkSwitch'
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
  networkResponse: OtcNetworkReads['networkResponse'],
): (hash?: Hex) => Promise<void> {
  const { clearUncertainTransaction, setError } = submission
  return useCallback(
    async (hash?: Hex) => {
      try {
        await clearUncertainTransaction(async () => {
          const originalForkId = networkResponse.data
          const currentForkId = await networkResponse.mutate()
          if (!originalForkId || currentForkId !== originalForkId) throw new Error('Ophis OTC wallet network changed')
        }, hash)
      } catch (caught) {
        setError(translateOtcWriteError(caught))
      }
    },
    [clearUncertainTransaction, networkResponse, setError],
  )
}

export function useOtcActionController(
  definition: OtcActionDefinition,
  onConfirmed: OtcConfirmedCallback | undefined,
): OtcActionController {
  const { account, chainId } = useWalletInfo()
  const connectWallet = useToggleWalletModal()
  const { enabled, configured, authorization } = useOtcWriteAuthorization()
  const canary = authorization.writeMode === 'canary'
  const walletAdmitted = !canary || isOtcCanaryAccount(account)
  const { data: walletClient } = useWalletClient()
  const allowanceToken = definition.allowanceToken ?? null
  const network = useOtcNetworkReads(configured && walletAdmitted, account, chainId, walletClient, allowanceToken)
  const refreshAllowance = useCallback(() => network.allowanceResponse.mutate(), [network.allowanceResponse])
  const submission = useOtcSubmission({
    writeClient: network.writeClient,
    wallet: network.wallet,
    authorization,
    resetKey: `${network.networkResponse.data ?? 'unverified'}\u0000${definition.resetKey}`,
    account,
    requiredAllowance: definition.requiredAllowance,
    refreshAllowance,
    onConfirmed,
  })
  const accountKey = account ? getAddressKey(account) : null
  const switchKey = JSON.stringify([enabled, walletAdmitted, accountKey, chainId, network.transportId])
  const { switching, switchToEthereum } = useOtcNetworkSwitch(canary, walletClient, submission.setError, switchKey)
  const allowance = network.allowanceResponse.data?.allowance ?? null
  const model = useOtcControllerModel({ definition, network, submission, enabled, account, chainId, canary, switching })

  const runPrimary = useCallback(async () => {
    switch (model.action) {
      case 'connect':
        connectWallet()
        return
      case 'switch':
        await switchToEthereum()
        return
      case 'approve':
      case 'revoke':
      case 'execute':
        await submitPrimaryAction(model.action, definition, submission)
        return
      case 'unavailable':
        return
    }
  }, [connectWallet, definition, model.action, submission, switchToEthereum])

  const error =
    submission.error ??
    (network.allowanceResponse.error ? translateOtcWriteError(network.allowanceResponse.error) : null)
  const { successHash, uncertainHash, signatureUncertain } = submission
  const clearUncertainTransaction = useOtcRecoveryClear(submission, network.networkResponse)

  return useMemo(
    () => ({
      canary,
      model,
      error,
      successHash,
      uncertainHash,
      signatureUncertain,
      allowance,
      diagnostic: localDiagnostic(network.allowanceResponse.error),
      clearUncertainTransaction,
      runPrimary,
    }),
    [
      allowance,
      canary,
      clearUncertainTransaction,
      network.allowanceResponse.error,
      error,
      model,
      runPrimary,
      signatureUncertain,
      successHash,
      uncertainHash,
    ],
  )
}

async function submitPrimaryAction(
  action: 'approve' | 'revoke' | 'execute',
  definition: OtcActionDefinition,
  submission: OtcSubmissionState,
): Promise<void> {
  const intent = {
    approve: definition.approvalIntent,
    revoke: definition.revokeIntent,
    execute: definition.executeIntent,
  }[action]
  if (intent) await submission.submit(intent, action === 'execute')
}
