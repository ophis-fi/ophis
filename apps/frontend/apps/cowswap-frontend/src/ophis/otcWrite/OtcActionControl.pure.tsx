import { useState, type ReactNode } from 'react'

import { LinkStyledButton } from '@cowprotocol/ui'

import { Callout } from 'ophis/ds'
import { formatOtcAmount } from 'ophis/otc'

import * as styledEl from './OtcWrite.styled'

import type { OtcActionController } from './useOtcActionController'
import type { Hex } from 'viem'

export interface OtcActionControlViewProps {
  controller: OtcActionController
  requiredAllowance: bigint | null | undefined
  allowanceTokenDecimals: number | undefined
  allowanceTokenSymbol: string | undefined
}

function UncertainTransactionRecovery({
  transactionHash,
  clearUncertainTransaction,
  mainnet,
}: {
  transactionHash: string
  clearUncertainTransaction(): void
  mainnet: boolean
}): ReactNode {
  const [verifiedDropped, setVerifiedDropped] = useState(false)
  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      <Callout tone="warning" title="Confirmation unavailable">
        <p>Submitted transaction: {transactionHash}</p>
        {mainnet ? (
          <p>
            Check Ethereum for confirmation before continuing. A missing receipt does not prove that a transaction or
            its replacement was dropped. If confirmation is recovered, reload to review the current order and allowance
            before starting another action.
          </p>
        ) : (
          <label>
            <input
              type="checkbox"
              checked={verifiedDropped}
              onChange={(event) => setVerifiedDropped(event.target.checked)}
            />{' '}
            I verified this transaction and its replacements were never mined on this fork.
          </label>
        )}
        <p>
          <LinkStyledButton
            type="button"
            disabled={!mainnet && !verifiedDropped}
            onClick={() => clearUncertainTransaction()}
          >
            {mainnet ? 'Check Ethereum confirmation' : 'Clear this lock and allow a fresh preflight'}
          </LinkStyledButton>
          .
        </p>
      </Callout>
    </div>
  )
}

function UnknownSubmissionRecovery({ reconcile }: { reconcile(hash?: Hex): void }): ReactNode {
  const [hash, setHash] = useState('')
  const validHash = /^0x[0-9a-fA-F]{64}$/.test(hash)
  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      <Callout tone="warning" title="Submission outcome unknown">
        <p>
          The wallet did not return a transaction hash. It may have submitted this action. Check wallet activity and
          current escrow orders; do not repeat the action or clear browser storage to bypass this lock.
        </p>
        <label>
          Transaction hash from wallet activity
          <input
            type="text"
            value={hash}
            maxLength={66}
            onChange={(event) => setHash(event.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <p>
          <LinkStyledButton type="button" disabled={!validHash} onClick={() => reconcile(hash as Hex)}>
            Check this transaction on Ethereum
          </LinkStyledButton>
        </p>
        <p>
          Only a mined transaction matching the reviewed action can resolve this warning. A missing or unrelated receipt
          leaves the action locked; contact the canary operator if no hash is available.
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
            {controller.diagnostic && <p>Wallet diagnostic: {controller.diagnostic}</p>}
          </Callout>
        </div>
      )}
      {controller.successHash && (
        <div role="status" aria-live="polite" aria-atomic="true">
          <Callout tone="info" title="Transaction confirmed">
            <p>Transaction confirmation: {controller.successHash}</p>
          </Callout>
        </div>
      )}
      {controller.signatureUncertain && !controller.model.pending && (
        <UnknownSubmissionRecovery reconcile={controller.clearUncertainTransaction} />
      )}
      {controller.uncertainHash && !controller.model.pending && (
        <UncertainTransactionRecovery
          key={controller.uncertainHash}
          transactionHash={controller.uncertainHash}
          clearUncertainTransaction={controller.clearUncertainTransaction}
          mainnet={!!controller.mainnet}
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
