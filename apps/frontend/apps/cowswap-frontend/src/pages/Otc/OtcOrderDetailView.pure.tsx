import type { ReactNode } from 'react'

import { Badge, Callout, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta, OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'

import { BadgeRow, Mono, RawNote } from './Otc.styled'
import { OtcFreshnessNotice, type OtcNodeFreshness } from './otcDetailFreshness'
import { formatOtcAge } from './otcDisplay'
import { indexedOtcOrderDisagrees } from './otcOrderDetail.utils'

import type { KeyValueRow } from 'ophis/ds'
import type { OtcIndexedOrder, OtcOrder } from 'ophis/otc'

const ETHERSCAN = 'https://etherscan.io/address'

function TokenLeg({ label, token, amount }: { label: string; token: string; amount: bigint }): ReactNode {
  const meta = getOtcTokenMeta(token)
  return (
    <div>
      <p>
        <strong>{label}:</strong>{' '}
        {meta ? (
          <Mono>
            {formatOtcAmount(amount, meta.decimals)} {meta.symbol}
          </Mono>
        ) : (
          <span>
            <Mono>{amount.toString()}</Mono>
            <RawNote>raw units</RawNote>
          </span>
        )}
      </p>
      <p>
        <Mono>{token}</Mono>{' '}
        <TextLink href={`${ETHERSCAN}/${token}`} external>
          View on Etherscan
        </TextLink>
      </p>
      {meta ? (
        meta.escrowRisks.length > 0 && (
          <p>
            Escrow lock risk: <Mono>{meta.escrowRisks.join(', ')}</Mono>
          </p>
        )
      ) : (
        <Badge tone="draft">Unreviewed token</Badge>
      )}
    </div>
  )
}

export interface OtcOrderDetailViewProps {
  orderId: bigint
  loading: boolean
  failed: boolean
  /** Freshness of the RPC node that served this direct order read. */
  freshness: OtcNodeFreshness
  order: OtcOrder | null
  blockNumber: bigint | null
  indexed: OtcIndexedOrder | null
  nowMs: number
  actionPanel?: ReactNode
  writeEnabled?: boolean
}

function DetailBody({
  orderId,
  order,
  blockNumber,
  indexed,
  nowMs,
  actionPanel,
  writeEnabled,
}: Omit<OtcOrderDetailViewProps, 'loading' | 'failed'>): ReactNode {
  if (!order) {
    return (
      <Callout tone="info" title="Order not found">
        <p>No order exists with id {orderId.toString()} on the escrow contract.</p>
      </Callout>
    )
  }

  const changed = indexed !== null && indexedOtcOrderDisagrees(indexed, order)
  const technicalRows: KeyValueRow[] = [
    { label: 'Escrow contract', value: <Mono>{OPHIS_ETHEREUM_OTC_MANIFEST.contract.address}</Mono> },
    { label: 'Order id', value: order.orderId.toString() },
    { label: 'Verified at block', value: blockNumber ? blockNumber.toString() : '—' },
  ]

  return (
    <>
      {changed && (
        <Callout
          tone="warning"
          title={writeEnabled ? 'Canonical index differs' : 'Order data changed — refresh required'}
        >
          <p>
            The indexed copy of this order disagrees with current on-chain state.{' '}
            {writeEnabled
              ? 'Fork actions ignore this checkpoint and re-read exact fork state before opening the wallet.'
              : 'Refresh before relying on it.'}
          </p>
        </Callout>
      )}
      <Section id="otc-order-terms" title="Terms">
        <BadgeRow>
          <Badge tone={order.active ? 'live' : 'draft'}>{order.active ? 'Active' : 'Inactive'}</Badge>
          {order.active && <Badge tone="audit">Escrowed</Badge>}
          {blockNumber && <span>Verified on-chain at block {blockNumber.toLocaleString('en-US')}</span>}
        </BadgeRow>
        <TokenLeg label="Maker sells" token={order.tokenA} amount={order.amountA} />
        <TokenLeg label="Maker wants" token={order.tokenB} amount={order.amountB} />
        <p>
          <strong>Maker:</strong> <Mono>{order.maker}</Mono>{' '}
          <TextLink href={`${ETHERSCAN}/${order.maker}`} external>
            View on Etherscan
          </TextLink>
        </p>
        {indexed && <p>Created {formatOtcAge(nowMs, indexed.createdAt)}</p>}
      </Section>
      {!writeEnabled && (!changed || !order.active) && actionPanel}
      <Section id="otc-order-technical" title="Technical details">
        <KeyValueList items={technicalRows} />
        <p>
          <TextLink href={`${ETHERSCAN}/${OPHIS_ETHEREUM_OTC_MANIFEST.contract.address}`} external>
            Escrow contract on Etherscan
          </TextLink>
        </p>
      </Section>
    </>
  )
}

export function OtcOrderDetailView(props: OtcOrderDetailViewProps): ReactNode {
  const { orderId, loading, failed, freshness, writeEnabled = false } = props

  return (
    <PageShell
      width="narrow"
      eyebrow="OTC"
      title={`Order #${orderId.toString()}`}
      lede={
        writeEnabled
          ? 'Fork-only action detail, freshly verified against the pinned escrow contract.'
          : 'Read-only order detail, verified directly against Ethereum.'
      }
    >
      <OtcFreshnessNotice freshness={freshness} loading={loading} failed={failed} />
      {loading && <p>Verifying order #{orderId.toString()} on Ethereum...</p>}
      {failed && (
        <Callout tone="warning" title="Order unavailable">
          <p>On-chain verification failed, so this order is hidden rather than shown unverified. Refresh to retry.</p>
        </Callout>
      )}
      {!loading && !failed && <DetailBody {...props} />}
      {writeEnabled && props.actionPanel}
    </PageShell>
  )
}
