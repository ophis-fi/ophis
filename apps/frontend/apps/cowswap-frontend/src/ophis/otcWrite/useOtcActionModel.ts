import { useMemo } from 'react'

import { deriveOtcActionModel, type OtcActionFacts, type OtcActionModel } from './otcActionModel'

export function useOtcActionModel(facts: OtcActionFacts): OtcActionModel {
  const {
    enabled,
    connected,
    correctChain,
    localForkVerified,
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
        connected,
        correctChain,
        localForkVerified,
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
      executeLabel,
      localForkVerified,
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
