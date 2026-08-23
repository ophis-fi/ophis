import type { ReactNode } from 'react'

import { OtcActionControlView } from './OtcActionControl.pure'
import { useOtcActionController, type OtcActionDefinition } from './useOtcActionController'

import type { OtcConfirmedCallback } from './otcWrite.types'

export interface OtcActionControlProps {
  definition: OtcActionDefinition
  onConfirmed: OtcConfirmedCallback | undefined
}

export function OtcActionControl({ definition, onConfirmed }: OtcActionControlProps): ReactNode {
  const controller = useOtcActionController(definition, onConfirmed)
  return (
    <OtcActionControlView
      controller={controller}
      requiredAllowance={definition.requiredAllowance}
      allowanceTokenDecimals={definition.allowanceTokenDecimals}
      allowanceTokenSymbol={definition.allowanceTokenSymbol}
    />
  )
}
