import type { ReactNode } from 'react'

import { Badge, Table, Tbody, Td, Th, Thead, Tr } from 'ophis/ds'
import { formatOtcAmount, getOtcTokenMeta } from 'ophis/otc'

import { Mono, RawNote, StatusStack } from './Otc.styled'
import { formatOtcAge } from './otcDisplay'

import type { OtcDisplayRow, OtcResolution } from './otcDisplay'

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
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
      <RawNote>raw units</RawNote> <Mono aria-label={`Token address ${token}`}>{truncateAddress(token)}</Mono>
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
    <StatusStack>
      <Badge tone={row.resolution === 'active' ? 'live' : 'draft'}>{RESOLUTION_LABEL[row.resolution]}</Badge>
      {row.verified && <Badge tone="audit">Verified on-chain</Badge>}
      {row.mismatch && <Badge tone="planned">Data mismatch</Badge>}
      {!row.reviewed && <Badge tone="draft">Unreviewed token</Badge>}
    </StatusStack>
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

function OtcOrderRow({ row, nowMs }: { row: OtcDisplayRow; nowMs: number }): ReactNode {
  return (
    <Tr>
      <Td>
        <Mono>#{row.order.orderId.toString()}</Mono>
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
        <Mono aria-label={`Maker address ${row.order.maker}`}>{truncateAddress(row.order.maker)}</Mono>
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
