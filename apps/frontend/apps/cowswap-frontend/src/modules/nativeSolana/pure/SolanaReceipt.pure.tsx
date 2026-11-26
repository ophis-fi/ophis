import { ReactNode, useEffect, useRef, useState } from 'react'

import { Trans } from '@lingui/react/macro'
import { ArrowLeft, ArrowUpRight, CheckCircle, ChevronDown } from 'react-feather'

import { Values } from './NativeSolana.styled'
import * as styledEl from './SolanaReceipt.styled'
import { ReceiptSlabs, ReceiptAmount, type VerifyReceiptAsset } from './SolanaReceiptAmounts.pure'
import { Back, Line } from './SwapForm.styled'

import { type SolanaAsset } from '../services/assets.service'
import {
  receiptTxLink,
  savedReceiptAmounts,
  type ReceiptAmounts,
  type ReceiptStatus,
} from '../services/receipt.service'

import type { SavedNativeSolanaOrder } from '../state/orders.atoms'
import type { OphisSolanaOrder, OphisSolanaTrade } from '@ophis/solana-sdk'

function statusLabel(status: ReceiptStatus): ReactNode {
  switch (status) {
    case 'fulfilled':
      return <Trans>Filled</Trans>
    case 'open':
      return <Trans>Open</Trans>
    case 'expired':
      return <Trans>Expired</Trans>
    case 'cancelled':
      return <Trans>Cancelled</Trans>
    case 'failed':
      return <Trans>Failed</Trans>
    case 'unconfirmed':
      return <Trans>Unconfirmed</Trans>
    case 'closed':
      return <Trans>Closed</Trans>
    case 'pending':
      return <Trans>Confirming</Trans>
  }
}

export function ReceiptStatusBadge({ status }: { status: ReceiptStatus }): ReactNode {
  return (
    <styledEl.Status $filled={status === 'fulfilled'} role="status">
      {status === 'fulfilled' && <CheckCircle size={13} aria-hidden="true" />} {statusLabel(status)}
    </styledEl.Status>
  )
}

interface ReceiptProps {
  verifyAsset: VerifyReceiptAsset
  saved?: SavedNativeSolanaOrder
  data?: OphisSolanaOrder
  trade?: OphisSolanaTrade
  status: ReceiptStatus
  assets: SolanaAsset[]
  onBack(): void
  timing?: ReactNode
  notice?: ReactNode
  actions?: ReactNode
  details?: ReactNode
}

function Detail({ label, children }: { label: ReactNode; children: ReactNode }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  )
}

function ReceiptDetails({
  intent,
  data,
  trade,
  assets,
  placement,
  uid,
}: Pick<ReceiptProps, 'data' | 'trade' | 'assets'> & {
  intent?: ReceiptAmounts
  placement?: string
  uid?: string
}): ReactNode {
  return (
    <Values>
      {intent && (
        <Detail label={<Trans>Minimum received</Trans>}>
          <ReceiptAmount amount={intent.buyAmount} mint={intent.buyToken} assets={assets} />
        </Detail>
      )}
      {trade && (
        <Detail label={<Trans>Ophis fee</Trans>}>
          {trade.protocolFee !== null && trade.feeMint ? (
            <ReceiptAmount amount={trade.protocolFee} mint={trade.feeMint} assets={assets} />
          ) : (
            <Trans>Fee attribution unavailable</Trans>
          )}
        </Detail>
      )}
      {data?.creationDate && (
        <Detail label={<Trans>Placed</Trans>}>
          <time dateTime={data.creationDate}>{new Date(data.creationDate).toLocaleString()}</time>
        </Detail>
      )}
      {trade?.slot !== undefined && <Detail label={<Trans>Settlement slot</Trans>}>{trade.slot}</Detail>}
      {placement && (
        <Detail label={<Trans>Placement</Trans>}>
          <a href={placement} target="_blank" rel="noopener noreferrer">
            <Trans>View order transaction</Trans> ↗
          </a>
        </Detail>
      )}
      <Detail label={<Trans>Order ID</Trans>}>
        <code>{uid}</code>
      </Detail>
    </Values>
  )
}

export function SolanaReceipt({
  verifyAsset,
  saved,
  data,
  trade,
  status,
  assets,
  onBack,
  timing,
  notice,
  actions,
  details,
}: ReceiptProps): ReactNode {
  const [expanded, expand] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus({ preventScroll: true }), [])
  const intent = data ?? (saved && savedReceiptAmounts(saved))
  const settlement = receiptTxLink(trade?.txSignature)
  const placement = receiptTxLink(saved?.signature)
  const uid = trade?.orderUid ?? saved?.uid
  return (
    <styledEl.Receipt data-swap-receipt="" aria-label="Swap receipt">
      <Line>
        <Line>
          <Back type="button" onClick={onBack} aria-label="Back">
            <ArrowLeft size={18} />
          </Back>
          <h2 ref={heading} tabIndex={-1}>
            <Trans>Swap receipt</Trans>
          </h2>
        </Line>
        <ReceiptStatusBadge status={status} />
      </Line>
      <styledEl.Network>
        <img src="/logos/token-sol.svg" alt="" />
        Solana
      </styledEl.Network>
      <ReceiptSlabs verifyAsset={verifyAsset} trade={trade} data={data} assets={assets} intent={intent} />
      {timing}
      {notice}
      {settlement && (
        <styledEl.ExplorerAction
          href={settlement}
          aria-label="View settlement on Solana Explorer"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Trans>View settlement</Trans> <ArrowUpRight aria-hidden="true" size={14} />
        </styledEl.ExplorerAction>
      )}
      {!settlement && placement && (
        <a href={placement} target="_blank" rel="noopener noreferrer">
          <Trans>View order transaction</Trans> ↗
        </a>
      )}
      {actions}
      <details onToggle={(event) => expand(event.currentTarget.open)}>
        <summary>
          <Trans>Details</Trans>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        <ReceiptDetails
          intent={intent}
          data={data}
          trade={trade}
          assets={assets}
          placement={settlement ? placement : undefined}
          uid={uid}
        />
        {expanded && details}
      </details>
    </styledEl.Receipt>
  )
}
