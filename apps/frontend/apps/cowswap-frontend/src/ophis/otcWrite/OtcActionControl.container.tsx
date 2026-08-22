import type { ReactNode } from 'react'

import { OtcActionControlView } from './OtcActionControl.pure'
import { useOtcActionController, type OtcActionDefinition } from './useOtcActionController'

export interface OtcActionControlProps {
  definition: OtcActionDefinition
  onConfirmed: (() => void) | undefined
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
