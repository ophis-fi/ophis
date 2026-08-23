import type { ReactNode } from 'react'

import { DemoContainer } from 'cosmos.decorator'

import { OtcActionControlView } from './OtcActionControl.pure'

import type { OtcActionController } from './useOtcActionController'

const noop = async (): Promise<void> => undefined

function VisualState({
  title,
  controller,
  requiredAllowance,
}: {
  title: string
  controller: OtcActionController
  requiredAllowance: bigint | null
}): ReactNode {
  return (
    <DemoContainer>
      <h2>{title}</h2>
      <OtcActionControlView
        controller={controller}
        requiredAllowance={requiredAllowance}
        allowanceTokenDecimals={6}
        allowanceTokenSymbol="USDC"
      />
    </DemoContainer>
  )
}

const Fixtures = {
  'Fill ready': () => (
    <VisualState
      title="Fill ready"
      requiredAllowance={2_000_000_000n}
      controller={{
        model: { action: 'execute', label: 'Fill entire order', disabled: false, pending: false },
        error: null,
        successHash: null,
        uncertainHash: null,
        allowance: 2_000_000_000n,
        diagnostic: null,
        clearUncertainTransaction: () => undefined,
        runPrimary: noop,
      }}
    />
  ),
  'Cancel pending': () => (
    <VisualState
      title="Cancel pending"
      requiredAllowance={null}
      controller={{
        model: { action: 'unavailable', label: 'Cancelling order...', disabled: true, pending: true },
        error: null,
        successHash: null,
        uncertainHash: null,
        allowance: null,
        diagnostic: null,
        clearUncertainTransaction: () => undefined,
        runPrimary: noop,
      }}
    />
  ),
  'Recovery required': () => (
    <VisualState
      title="Recovery required"
      requiredAllowance={2_000_000_000n}
      controller={{
        model: { action: 'revoke', label: 'Revoke unused allowance', disabled: false, pending: false },
        error: 'The order changed before submission. Refresh the order and try again.',
        successHash: null,
        uncertainHash: null,
        allowance: 2_000_000_000n,
        diagnostic: null,
        clearUncertainTransaction: () => undefined,
        runPrimary: noop,
      }}
    />
  ),
}

export default Fixtures
