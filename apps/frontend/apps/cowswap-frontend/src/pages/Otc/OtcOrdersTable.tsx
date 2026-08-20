import type { ReactNode } from 'react'

import { Badge, Table, Tbody, Td, Th, Thead, Tr } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta } from 'ophis/otc'
import { Link } from 'react-router'

import { CopyButton, Mono, RawNote, VisuallyHidden } from './Otc.styled'
import { formatOtcAge } from './otcDisplay'

import type { OtcDisplayRow, OtcResolution } from './otcDisplay'

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
      <RawNote>raw units</RawNote> <AddressText address={token} />
    </span>
  )
}

const RESOLUTION_LABEL: Record<OtcResolution, string> = {
  active: 'Active',
  filled: 'Filled',
  cancelled: 'Cancelled',
  inactive: 'Inactive',
}

function StatusCell({ row }: { row: OtcDisplayRow }): ReactNode {
  return (
    <span>
      <Badge tone={row.resolution === 'active' ? 'live' : 'draft'}>{RESOLUTION_LABEL[row.resolution]}</Badge>{' '}
      {row.resolution === 'active' && <Badge tone="audit">Escrowed</Badge>}{' '}
      {row.mismatch && <Badge tone="planned">Index mismatch</Badge>}
      {!row.reviewed && <Badge tone="draft">Unreviewed token</Badge>}
    </span>
  )
}

function RateCell({ row }: { row: OtcDisplayRow }): ReactNode {
  if (!row.rate) return <span aria-label="Rate unavailable">—</span>
  const metaA = getOtcTokenMeta(row.order.tokenA)
  const metaB = getOtcTokenMeta(row.order.tokenB)
  return (
    <Mono>
      {row.rate.rate} {metaB?.symbol} per {metaA?.symbol}
    </Mono>
  )
}

function MakerCell({ maker }: { maker: string }): ReactNode {
  return (
    <span>
      <AddressText address={maker} />
      <CopyButton
        type="button"
        aria-label={`Copy maker address ${maker}`}
        onClick={() => void navigator.clipboard?.writeText(maker)}
      >
        Copy
      </CopyButton>{' '}
      <a href={`${ETHERSCAN}/${maker}`} target="_blank" rel="noreferrer" aria-label={`Maker ${maker} on Etherscan`}>
        ↗
      </a>
    </span>
  )
}

function OtcOrderRow({ row, nowMs }: { row: OtcDisplayRow; nowMs: number }): ReactNode {
  const orderId = row.order.orderId.toString()
  return (
    <Tr>
      <Td>
        <Link to={`/otc/${orderId}`} aria-label={`Order ${orderId} details`}>
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
      <Td>{formatOtcAge(nowMs, row.createdAt)}</Td>
      <Td>
        <StatusCell row={row} />
      </Td>
    </Tr>
  )
}

interface OtcOrdersTableProps {
  rows: OtcDisplayRow[]
  nowMs: number
  caption: string
}

export function OtcOrdersTable({ rows, nowMs, caption }: OtcOrdersTableProps): ReactNode {
  return (
    <Table caption={caption}>
      <Thead>
        <Tr>
          <Th>Order</Th>
          <Th>Sells</Th>
          <Th>Wants</Th>
          <Th>Rate</Th>
          <Th>Maker</Th>
          <Th>Age</Th>
          <Th>Status</Th>
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
