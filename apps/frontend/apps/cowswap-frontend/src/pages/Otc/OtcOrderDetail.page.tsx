/**
 * OtcOrderDetailPage — /otc/:orderId (OTC Milestone B, read-only).
 *
 * Opening a detail view performs a DIRECT getOrder read against Ethereum
 * (with the pinned code-hash check) — indexed data is never presented as
 * current state. When the indexed row disagrees with the chain, the page
 * demands a refresh instead of showing an actionable-looking order.
 */
import { useId, useMemo, type ReactNode } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { Badge, Callout, KeyValueList, PageShell, Section, TextLink } from 'ophis/ds'
import {
  formatOtcAmount,
  getOtcTokenMeta,
  readOtcOrder,
  toOtcReaderClient,
  useOtcData,
  OPHIS_ETHEREUM_OTC_MANIFEST,
  OTC_DATA_REFRESH_INTERVAL,
} from 'ophis/otc'
import { Navigate, useParams } from 'react-router'
import useSWR from 'swr'
import { usePublicClient } from 'wagmi'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { BadgeRow, Mono, RawNote } from './Otc.styled'
import { formatOtcAge } from './otcDisplay'
import { useOtcPageEnabled } from './useOtcPageEnabled'

import type { KeyValueRow } from 'ophis/ds'
import type { OtcIndexedOrder, OtcOrder, OtcReaderClient } from 'ophis/otc'

const ETHERSCAN = 'https://etherscan.io/address'

function indexedDisagrees(indexed: OtcIndexedOrder, order: OtcOrder): boolean {
  return (
    indexed.maker.toLowerCase() !== order.maker.toLowerCase() ||
    indexed.active !== order.active ||
    indexed.tokenA.toLowerCase() !== order.tokenA.toLowerCase() ||
    indexed.amountA !== order.amountA ||
    indexed.tokenB.toLowerCase() !== order.tokenB.toLowerCase() ||
    indexed.amountB !== order.amountB
  )
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

interface OtcOrderDetailViewProps {
  orderId: bigint
  loading: boolean
  failed: boolean
  order: OtcOrder | null
  blockNumber: bigint | null
  indexed: OtcIndexedOrder | null
  nowMs: number
}

function DetailBody({
  orderId,
  order,
  blockNumber,
  indexed,
  nowMs,
}: Omit<OtcOrderDetailViewProps, 'loading' | 'failed'>): ReactNode {
  if (!order) {
    return (
      <Callout tone="info" title="Order not found">
        <p>No order exists with id {orderId.toString()} on the escrow contract.</p>
      </Callout>
    )
  }

  const changed = indexed !== null && indexedDisagrees(indexed, order)
  const technicalRows: KeyValueRow[] = [
    { label: 'Escrow contract', value: <Mono>{OPHIS_ETHEREUM_OTC_MANIFEST.contract.address}</Mono> },
    { label: 'Order id', value: order.orderId.toString() },
    { label: 'Verified at block', value: blockNumber ? blockNumber.toString() : '—' },
  ]

  return (
    <>
      {changed && (
        <Callout tone="warning" title="Order data changed — refresh required">
          <p>The indexed copy of this order disagrees with current on-chain state. Refresh before relying on it.</p>
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
  const { orderId, loading, failed } = props

  return (
    <PageShell
      width="narrow"
      eyebrow="OTC"
      title={`Order #${orderId.toString()}`}
      lede="Read-only order detail, verified directly against Ethereum."
    >
      {loading && <p>Verifying order #{orderId.toString()} on Ethereum...</p>}
      {failed && (
        <Callout tone="warning" title="Order unavailable">
          <p>On-chain verification failed, so this order is hidden rather than shown unverified. Refresh to retry.</p>
        </Callout>
      )}
      {!loading && !failed && <DetailBody {...props} />}
    </PageShell>
  )
}

export function OtcOrderDetailPage(): ReactNode {
  const enabled = useOtcPageEnabled()
  const params = useParams()
  const rawOrderId = params.orderId ?? ''
  const validId = /^\d{1,18}$/.test(rawOrderId)
  const orderId = validId ? BigInt(rawOrderId) : 0n

  const publicClient = usePublicClient({ chainId: SupportedChainId.MAINNET })
  const client = useMemo<OtcReaderClient | null>(
    () => (publicClient ? toOtcReaderClient(publicClient) : null),
    [publicClient],
  )
  const state = useOtcData(enabled && validId)

  // Mount-unique key: SWR must never serve a cached order from a previous
  // visit as if it were the promised fresh direct read — every mount starts
  // at loading until its own getOrder round-trip completes.
  const mountId = useId()
  const { data, error } = useSWR(
    enabled && validId && client ? ['ophis-otc-order', rawOrderId, mountId] : null,
    async () => (client ? readOtcOrder(client, orderId) : null),
    { refreshInterval: OTC_DATA_REFRESH_INTERVAL, revalidateOnFocus: false },
  )

  if (!enabled) return <Navigate to={RoutesEnum.HOME} replace />
  if (!validId) return <Navigate to={RoutesEnum.OTC} replace />

  const indexed = state.enrichment?.byOrderId.get(orderId.toString()) ?? null
  // Wall-clock read for the relative created-age line only.

  const nowMs = Date.now()

  return (
    <OtcOrderDetailView
      orderId={orderId}
      loading={!data && !error}
      failed={Boolean(error)}
      order={data?.order ?? null}
      blockNumber={data?.blockNumber ?? null}
      indexed={indexed}
      nowMs={nowMs}
    />
  )
}
