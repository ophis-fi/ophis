import type { ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import { Badge, Table, Tbody, Td, Th, Thead, Tr } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta } from 'ophis/otc'
import { Link } from 'react-router'

import { CopyButton, Mono, RawNote, VisuallyHidden } from './Otc.styled'
import { OtcAge } from './OtcAge'

import type { OtcDisplayRow } from './otcDisplay'

const ETHERSCAN = 'https://etherscan.io/address'

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

/** Truncated display with the full address available to screen readers. */
function AddressText({ address }: { address: string }): ReactNode {
  return (
    <Mono>
      <span aria-hidden="true">{truncateAddress(address)}</span>
      <VisuallyHidden>{address}</VisuallyHidden>
    </Mono>
  )
}

function AmountCell({ token, amount }: { token: string; amount: bigint }): ReactNode {
  const meta = getOtcTokenMeta(token)
  if (meta) {
    return (
      <Mono>
        {formatOtcAmount(amount, meta.decimals)} {meta.symbol}
      </Mono>
    )
  }
  return (
    <span>
      <Mono>{amount.toString()}</Mono>
      <RawNote>
        <Trans>raw units</Trans>
      </RawNote>{' '}
      <AddressText address={token} />
    </span>
  )
}

function StatusCell({ row }: { row: OtcDisplayRow }): ReactNode {
  return (
    <span>
      <Badge tone={row.resolution === 'active' ? 'live' : 'draft'}>
        {row.resolution === 'active' ? <Trans>Active</Trans> : <Trans>Inactive</Trans>}
      </Badge>{' '}
      {row.verified && (
        <Badge tone="audit">
          <Trans>Verified on-chain</Trans>
        </Badge>
      )}{' '}
      {row.resolution === 'active' && (
        <Badge tone="audit">
          <Trans>Escrowed</Trans>
        </Badge>
      )}{' '}
      {row.indexClaim === 'filled' && (
        <RawNote>
          <Trans>index: filled</Trans>
        </RawNote>
      )}{' '}
      {row.indexClaim === 'cancelled' && (
        <RawNote>
          <Trans>index: cancelled</Trans>
        </RawNote>
      )}{' '}
      {row.mismatch && (
        <Badge tone="planned">
          <Trans>Index mismatch</Trans>
        </Badge>
      )}
      {!row.reviewed && (
        <Badge tone="draft">
          <Trans>Unreviewed token</Trans>
        </Badge>
      )}
    </span>
  )
}

function RateCell({ row }: { row: OtcDisplayRow }): ReactNode {
  const { t } = useLingui()
  if (!row.rate) return <span aria-label={t`Rate unavailable`}>—</span>
  const metaA = getOtcTokenMeta(row.order.tokenA)
  const metaB = getOtcTokenMeta(row.order.tokenB)
  return (
    <Mono>
      {row.rate.rate} {metaB?.symbol} <Trans>per</Trans> {metaA?.symbol}
    </Mono>
  )
}

function MakerCell({ maker }: { maker: string }): ReactNode {
  const { t } = useLingui()
  return (
    <span>
      <AddressText address={maker} />
      <CopyButton
        type="button"
        aria-label={t`Copy maker address ${maker}`}
        onClick={() => void navigator.clipboard?.writeText(maker)}
      >
        <Trans>Copy</Trans>
      </CopyButton>{' '}
      <a href={`${ETHERSCAN}/${maker}`} target="_blank" rel="noreferrer" aria-label={t`Maker ${maker} on Etherscan`}>
        ↗
      </a>
    </span>
  )
}

function OtcOrderRow({ row, nowMs }: { row: OtcDisplayRow; nowMs: number }): ReactNode {
  const orderId = row.order.orderId.toString()
  const { t } = useLingui()
  return (
    <Tr>
      <Td>
        <Link to={`/otc/${orderId}`} aria-label={t`Order ${orderId} details`}>
          <Mono>#{orderId}</Mono>
        </Link>
      </Td>
      <Td>
        <AmountCell token={row.order.tokenA} amount={row.order.amountA} />
      </Td>
      <Td>
        <AmountCell token={row.order.tokenB} amount={row.order.amountB} />
      </Td>
      <Td>
        <RateCell row={row} />
      </Td>
      <Td>
        <MakerCell maker={row.order.maker} />
      </Td>
      <Td>
        <OtcAge nowMs={nowMs} createdAt={row.createdAt} />
      </Td>
      <Td>
        <StatusCell row={row} />
      </Td>
    </Tr>
  )
}

interface OtcOrdersTableProps {
  rows: OtcDisplayRow[]
  nowMs: number
  caption: ReactNode
}

export function OtcOrdersTable({ rows, nowMs, caption }: OtcOrdersTableProps): ReactNode {
  return (
    <Table caption={caption}>
      <Thead>
        <Tr>
          <Th>
            <Trans>Order</Trans>
          </Th>
          <Th>
            <Trans>Sells</Trans>
          </Th>
          <Th>
            <Trans>Wants</Trans>
          </Th>
          <Th>
            <Trans>Rate</Trans>
          </Th>
          <Th>
            <Trans>Maker</Trans>
          </Th>
          <Th>
            <Trans>Age</Trans>
          </Th>
          <Th>
            <Trans>Status</Trans>
          </Th>
        </Tr>
      </Thead>
      <Tbody>
        {rows.map((row) => (
          <OtcOrderRow key={row.order.orderId.toString()} row={row} nowMs={nowMs} />
        ))}
      </Tbody>
    </Table>
  )
}
