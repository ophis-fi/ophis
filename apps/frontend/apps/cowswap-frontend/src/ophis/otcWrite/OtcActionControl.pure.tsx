import type { ReactNode } from 'react'

import { Callout } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'

import * as styledEl from './OtcWrite.styled'

import type { OtcActionController } from './useOtcActionController'

export interface OtcActionControlViewProps {
  controller: OtcActionController
  requiredAllowance: bigint | null | undefined
  allowanceTokenDecimals: number | undefined
  allowanceTokenSymbol: string | undefined
}

export function OtcActionControlView(props: OtcActionControlViewProps): ReactNode {
  const { controller, requiredAllowance, allowanceTokenDecimals, allowanceTokenSymbol } = props
  return (
    <>
      {controller.model.action === 'revoke' && (
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <Callout tone="warning" title="Unused token allowance remains">
            <p>Revoke the current escrow allowance before approving or executing with an exact amount.</p>
          </Callout>
        </div>
      )}
      {controller.error && (
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <Callout tone="warning" title="Transaction not completed">
            <p>{controller.error}</p>
            {controller.diagnostic && <p>Local fork diagnostic: {controller.diagnostic}</p>}
          </Callout>
        </div>
      )}
      {controller.successHash && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <Callout tone="info" title="Transaction confirmed">
            <p>Local fork confirmation: {controller.successHash}</p>
          </Callout>
        </div>
      )}
      <styledEl.PrimaryAction
        type="button"
        disabled={controller.model.disabled}
        aria-disabled={controller.model.disabled}
        aria-busy={controller.model.pending}
        onClick={() => controller.runPrimary()}
      >
        {controller.model.label}
      </styledEl.PrimaryAction>
      {requiredAllowance !== null && requiredAllowance !== undefined && (
        <styledEl.InlineStatus role="status" aria-live="polite" aria-atomic="true">
          Exact escrow allowance:{' '}
          {controller.allowance === null
            ? 'checking…'
            : allowanceTokenDecimals !== undefined && allowanceTokenSymbol
              ? `${formatOtcAmount(controller.allowance, allowanceTokenDecimals)} ${allowanceTokenSymbol}`
              : controller.allowance.toString()}
        </styledEl.InlineStatus>
      )}
    </>
  )
}
