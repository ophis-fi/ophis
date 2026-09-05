import { Fragment, type ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import { Badge, Callout, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta, OPHIS_ETHEREUM_OTC_MANIFEST } from 'ophis/otc'

import { BadgeRow, Mono, RawNote } from './Otc.styled'
import { OtcAge } from './OtcAge'
import { OtcFreshnessNotice } from './otcDetailFreshness'
import { indexedOtcOrderDisagrees } from './otcOrderDetail.utils'

import type { OtcNodeFreshness } from './otcDetailFreshness.utils'
import type { KeyValueRow } from 'ophis/ds'
import type { OtcIndexedOrder, OtcOrder } from 'ophis/otc'

const ETHERSCAN = 'https://etherscan.io/address'

function EscrowRiskLabel({ risk }: { risk: string }): ReactNode {
  if (risk === 'upgradeable') return <Trans>upgradeable</Trans>
  if (risk === 'blacklistable') return <Trans>blacklistable</Trans>
  return risk
}

function EscrowRiskList({ risks }: { risks: readonly string[] }): ReactNode {
  return risks.map((risk, index) => (
    <Fragment key={risk}>
      {index > 0 ? ', ' : null}
      <EscrowRiskLabel risk={risk} />
    </Fragment>
  ))
}

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
            <RawNote>
              <Trans>raw units</Trans>
            </RawNote>
          </span>
        )}
      </p>
      <p>
        <Mono>{token}</Mono>{' '}
        <TextLink href={`${ETHERSCAN}/${token}`} external>
          <Trans>View on Etherscan</Trans>
        </TextLink>
      </p>
      {meta ? (
        meta.escrowRisks.length > 0 && (
          <p>
            <Trans>Escrow lock risk:</Trans>{' '}
            <Mono>
              <EscrowRiskList risks={meta.escrowRisks} />
            </Mono>
          </p>
        )
      ) : (
        <Badge tone="draft">
          <Trans>Unreviewed token</Trans>
        </Badge>
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

function OrderTermsSection({
  order,
  blockNumber,
  indexed,
  nowMs,
}: Pick<OtcOrderDetailViewProps, 'order' | 'blockNumber' | 'indexed' | 'nowMs'> & { order: OtcOrder }): ReactNode {
  const { t, i18n } = useLingui()
  const verifiedBlock = blockNumber?.toLocaleString(i18n.locale) ?? null
  return (
    <Section id="otc-order-terms" title={<Trans>Terms</Trans>}>
      <BadgeRow>
        <Badge tone={order.active ? 'live' : 'draft'}>
          {order.active ? <Trans>Active</Trans> : <Trans>Inactive</Trans>}
        </Badge>
        {order.active && (
          <Badge tone="audit">
            <Trans>Escrowed</Trans>
          </Badge>
        )}
        {verifiedBlock && (
          <span>
            <Trans>Verified on-chain at block {verifiedBlock}</Trans>
          </span>
        )}
      </BadgeRow>
      <TokenLeg label={t`Maker sells`} token={order.tokenA} amount={order.amountA} />
      <TokenLeg label={t`Maker wants`} token={order.tokenB} amount={order.amountB} />
      <p>
        <strong>
          <Trans>Maker:</Trans>
        </strong>{' '}
        <Mono>{order.maker}</Mono>{' '}
        <TextLink href={`${ETHERSCAN}/${order.maker}`} external>
          <Trans>View on Etherscan</Trans>
        </TextLink>
      </p>
      {indexed && (
        <p>
          <Trans>Created</Trans> <OtcAge nowMs={nowMs} createdAt={indexed.createdAt} />
        </p>
      )}
    </Section>
  )
}

function TechnicalDetailsSection({ order, blockNumber }: { order: OtcOrder; blockNumber: bigint | null }): ReactNode {
  const { t } = useLingui()
  const technicalRows: KeyValueRow[] = [
    { label: t`Escrow contract`, value: <Mono>{OPHIS_ETHEREUM_OTC_MANIFEST.contract.address}</Mono> },
    { label: t`Order id`, value: order.orderId.toString() },
    { label: t`Verified at block`, value: blockNumber ? blockNumber.toString() : '—' },
  ]
  return (
    <Section id="otc-order-technical" title={<Trans>Technical details</Trans>}>
      <KeyValueList items={technicalRows} />
      <p>
        <TextLink href={`${ETHERSCAN}/${OPHIS_ETHEREUM_OTC_MANIFEST.contract.address}`} external>
          <Trans>Escrow contract on Etherscan</Trans>
        </TextLink>
      </p>
    </Section>
  )
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
  const orderIdText = orderId.toString()
  if (!order) {
    return (
      <Callout tone="info" title={<Trans>Order not found</Trans>}>
        <p>
          <Trans>No order exists with id {orderIdText} on the escrow contract.</Trans>
        </p>
      </Callout>
    )
  }

  const changed = indexed !== null && indexedOtcOrderDisagrees(indexed, order)

  return (
    <>
      {changed && (
        <Callout
          tone="warning"
          title={
            writeEnabled ? <Trans>Canonical index differs</Trans> : <Trans>Order data changed — refresh required</Trans>
          }
        >
          <p>
            <Trans>The indexed copy of this order disagrees with current on-chain state.</Trans>{' '}
            {writeEnabled ? (
              <Trans>Fork actions ignore this checkpoint and re-read exact fork state before opening the wallet.</Trans>
            ) : (
              <Trans>Refresh before relying on it.</Trans>
            )}
          </p>
        </Callout>
      )}
      <OrderTermsSection order={order} blockNumber={blockNumber} indexed={indexed} nowMs={nowMs} />
      {!writeEnabled && (!changed || !order.active) && actionPanel}
      <TechnicalDetailsSection order={order} blockNumber={blockNumber} />
    </>
  )
}

export function OtcOrderDetailView(props: OtcOrderDetailViewProps): ReactNode {
  const { orderId, loading, failed, freshness, writeEnabled = false } = props
  const orderIdText = orderId.toString()

  return (
    <PageShell
      width="narrow"
      eyebrow="OTC"
      title={<Trans>Order #{orderIdText}</Trans>}
      lede={
        writeEnabled ? (
          <Trans>Fork-only action detail, freshly verified against the pinned escrow contract.</Trans>
        ) : (
          <Trans>Read-only order detail, verified directly against Ethereum.</Trans>
        )
      }
    >
      <OtcFreshnessNotice freshness={freshness} loading={loading} failed={failed} />
      {loading && (
        <p>
          <Trans>Verifying order #{orderIdText} on Ethereum...</Trans>
        </p>
      )}
      {failed && (
        <Callout tone="warning" title={<Trans>Order unavailable</Trans>}>
          <p>
            <Trans>
              On-chain verification failed, so this order is hidden rather than shown unverified. Refresh to retry.
            </Trans>
          </p>
        </Callout>
      )}
      {!loading && !failed && <DetailBody {...props} />}
      {writeEnabled && props.actionPanel}
    </PageShell>
  )
}
