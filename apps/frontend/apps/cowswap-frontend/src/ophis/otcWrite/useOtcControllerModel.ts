import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { getOtcCanaryRestriction, isOtcCanaryAccount } from './otcCanaryPolicy'
import { useOtcActionModel } from './useOtcActionModel'

import type { OtcActionModel } from './otcActionModel'
import type { OtcNetworkId } from './otcWrite.types'
import type { OtcActionDefinition } from './useOtcActionController'
import type { OtcNetworkReads } from './useOtcNetworkReads'
import type { OtcSubmissionState } from './useOtcSubmission'
import type { Address } from 'viem'

function networkStatus(
  account: Address | undefined,
  chainId: number,
  data: OtcNetworkId | null | undefined,
  error: unknown,
): boolean | null {
  if (!account || chainId !== SupportedChainId.MAINNET) return null
  if (error) return false
  return data === undefined ? null : data !== null
}

interface ControllerModelOptions {
  definition: OtcActionDefinition
  network: OtcNetworkReads
  submission: OtcSubmissionState
  enabled: boolean
  account: Address | undefined
  chainId: number
  canary: boolean
  switching: boolean
}

export function useOtcControllerModel(options: ControllerModelOptions): OtcActionModel {
  const { definition, network, submission, enabled, account, chainId, canary, switching } = options
  const walletAdmitted = !canary || isOtcCanaryAccount(account)
  const allowance = network.allowanceResponse.data?.allowance ?? null
  const restriction = canaryRestriction(canary, definition)
  const networkVerified = networkStatus(account, chainId, network.networkResponse.data, network.networkResponse.error)
  return useOtcActionModel({
    enabled,
    canary,
    walletAdmitted,
    connected: !!account,
    correctChain: chainId === SupportedChainId.MAINNET,
    networkVerified,
    ready: definition.ready && !restriction,
    reviewed: definition.reviewed,
    allowance,
    allowanceFailed: !!network.allowanceResponse.error,
    requiredAllowance: definition.requiredAllowance ?? null,
    recoveryRequired: submission.recoveryRequired,
    allowanceCooldown: submission.allowanceCooldown,
    receiptConfirmed: submission.terminalConfirmed,
    receiptUncertain: submission.uncertainHash !== null || submission.signatureUncertain,
    pendingIntent: switching ? 'switch' : submission.pendingIntent,
    executeLabel: definition.executeLabel,
    unavailableLabel: restriction ?? definition.unavailableLabel ?? 'Complete the order terms',
  })
}

function canaryRestriction(canary: boolean, definition: OtcActionDefinition): string | null {
  return canary && definition.executeIntent
    ? getOtcCanaryRestriction(definition.executeIntent, BigInt(Math.floor(Date.now() / 1_000)))
    : null
}
