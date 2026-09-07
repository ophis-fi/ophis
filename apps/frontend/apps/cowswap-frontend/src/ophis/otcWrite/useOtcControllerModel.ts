import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { useOtcActionModel } from './useOtcActionModel'

import type { OtcActionModel } from './otcActionModel'
import type { OtcActionDefinition } from './useOtcActionController'
import type { OtcNetworkReads } from './useOtcNetworkReads'
import type { OtcSubmissionState } from './useOtcSubmission'
import type { Address, Hex } from 'viem'

interface ControllerModelOptions {
  definition: OtcActionDefinition
  network: OtcNetworkReads
  submission: OtcSubmissionState
  enabled: boolean
  account: Address | undefined
  chainId: number
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

export function useOtcControllerModel({
  definition,
  network,
  submission,
  enabled,
  account,
  chainId,
}: ControllerModelOptions): OtcActionModel {
  const allowance = network.allowanceResponse.data?.allowance ?? null
  const networkVerified = localForkStatus(
    account,
    chainId,
    network.localForkResponse.data,
    network.localForkResponse.error,
  )
  return useOtcActionModel({
    enabled,
    connected: !!account,
    correctChain: chainId === SupportedChainId.MAINNET,
    networkVerified,
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
}
