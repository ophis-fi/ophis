import { useState, type ReactNode } from 'react'

import { LinkStyledButton } from '@cowprotocol/ui'

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

function UncertainTransactionRecovery({
  transactionHash,
  clearUncertainTransaction,
}: {
  transactionHash: string
  clearUncertainTransaction(): void
}): ReactNode {
  const [verifiedDropped, setVerifiedDropped] = useState(false)
  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      <Callout tone="warning" title="Confirmation unavailable">
        <p>The transaction was submitted. Verify this exact hash on the local fork: {transactionHash}</p>
        <label>
          <input
            type="checkbox"
            checked={verifiedDropped}
            onChange={(event) => setVerifiedDropped(event.target.checked)}
          />{' '}
          I verified this hash was dropped and never mined.
        </label>
        <p>
          <LinkStyledButton type="button" disabled={!verifiedDropped} onClick={clearUncertainTransaction}>
            Clear this lock and allow a fresh preflight
          </LinkStyledButton>
          .
        </p>
      </Callout>
    </div>
  )
}

export function OtcActionControlView(props: OtcActionControlViewProps): ReactNode {
  const { controller, requiredAllowance, allowanceTokenDecimals, allowanceTokenSymbol } = props
  return (
    <>
      {controller.model.action === 'revoke' && (
        <div role="alert" aria-live="assertive" aria-atomic="true">
          <Callout tone="warning" title="Token allowance must be cleared">
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
      {controller.uncertainHash && !controller.model.pending && (
        <UncertainTransactionRecovery
          key={controller.uncertainHash}
          transactionHash={controller.uncertainHash}
          clearUncertainTransaction={controller.clearUncertainTransaction}
        />
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
