import { useMemo } from 'react'

import { deriveOtcActionModel, type OtcActionFacts, type OtcActionModel } from './otcActionModel'

export function useOtcActionModel(facts: OtcActionFacts): OtcActionModel {
  const {
    enabled,
    canary,
    walletAdmitted,
    connected,
    correctChain,
    networkVerified,
    ready,
    reviewed,
    allowance,
    allowanceFailed,
    requiredAllowance,
    recoveryRequired,
    allowanceCooldown,
    receiptConfirmed,
    receiptUncertain,
    pendingIntent,
    executeLabel,
    unavailableLabel,
  } = facts
  return useMemo(
    () =>
      deriveOtcActionModel({
        enabled,
        canary,
        walletAdmitted,
        connected,
        correctChain,
        networkVerified,
        ready,
        reviewed,
        allowance,
        allowanceFailed,
        requiredAllowance,
        recoveryRequired,
        allowanceCooldown,
        receiptConfirmed,
        receiptUncertain,
        pendingIntent,
        executeLabel,
        unavailableLabel,
      }),
    [
      allowance,
      allowanceCooldown,
      allowanceFailed,
      connected,
      correctChain,
      enabled,
      canary,
      walletAdmitted,
      executeLabel,
      networkVerified,
      pendingIntent,
      ready,
      receiptConfirmed,
      receiptUncertain,
      recoveryRequired,
      requiredAllowance,
      reviewed,
      unavailableLabel,
    ],
  )
}
