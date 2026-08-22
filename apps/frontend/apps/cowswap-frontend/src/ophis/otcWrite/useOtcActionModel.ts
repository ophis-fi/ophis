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
    pendingIntent,
    executeLabel,
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
        pendingIntent,
        executeLabel,
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
      recoveryRequired,
      requiredAllowance,
      reviewed,
    ],
  )
}
