import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { AccountType } from '@cowprotocol/types'
import { useAccountType, useWalletDetails } from '@cowprotocol/wallet'

import { getOtcCanaryRestriction, isOtcCanaryAccount } from './otcCanaryPolicy'
import { isOtcMainnetMode } from './otcWriteMode.utils'
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
  writeMode: string | undefined
  switching: boolean
}

export function useOtcControllerModel(options: ControllerModelOptions): OtcActionModel {
  const { definition, network, submission, enabled, account, chainId, writeMode, switching } = options
  const walletAdmitted = isWalletAdmitted(useAccountType(), useWalletDetails(), writeMode, account)
  const allowance = network.allowanceResponse.data?.allowance ?? null
  const restriction = canaryRestriction(writeMode === 'canary', definition)
  const networkVerified = networkStatus(account, chainId, network.networkResponse.data, network.networkResponse.error)
  return useOtcActionModel({
    enabled,
    mainnet: isOtcMainnetMode(writeMode),
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

function canaryRestriction(mainnet: boolean, definition: OtcActionDefinition): string | null {
  return mainnet && definition.executeIntent
    ? getOtcCanaryRestriction(definition.executeIntent, BigInt(Math.floor(Date.now() / 1_000)))
    : null
}

function isWalletAdmitted(
  type: AccountType | undefined,
  wallet: ReturnType<typeof useWalletDetails>,
  mode: string | undefined,
  account: Address | undefined,
): boolean {
  return (
    type === AccountType.EOA &&
    wallet.isSmartContractWallet === false &&
    !wallet.isSafeApp &&
    (mode !== 'canary' || isOtcCanaryAccount(account))
  )
}
