import type { ReactNode } from 'react'

import { OTC_CURATED_TOKENS } from 'ophis/otc'

import { FilterBar, FilterField } from './Otc.styled'

import type { OtcDisplayRow } from './otcDisplay'

export interface BrowseFilters {
  token: string
  maker: string
  orderId: string
}

export const EMPTY_BROWSE_FILTERS: BrowseFilters = { token: '', maker: '', orderId: '' }

export function applyBrowseFilters(rows: OtcDisplayRow[], filters: BrowseFilters): OtcDisplayRow[] {
  return rows.filter((row) => {
    if (filters.orderId.trim() !== '' && row.order.orderId.toString() !== filters.orderId.trim()) return false
    if (filters.maker.trim() !== '' && !row.order.maker.toLowerCase().includes(filters.maker.trim().toLowerCase())) {
      return false
    }
    if (filters.token !== '') {
      const needle = filters.token.toLowerCase()
      if (row.order.tokenA.toLowerCase() !== needle && row.order.tokenB.toLowerCase() !== needle) return false
    }
    return true
  })
}

export function BrowseFilterBar({
  filters,
  onChange,
}: {
  filters: BrowseFilters
  onChange: (filters: BrowseFilters) => void
}): ReactNode {
  return (
    <FilterBar>
      <FilterField>
        <label htmlFor="otc-filter-token">Filter by token</label>
        <select
          id="otc-filter-token"
          value={filters.token}
          onChange={(event) => onChange({ ...filters, token: event.target.value })}
        >
          <option value="">All tokens</option>
          {OTC_CURATED_TOKENS.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField>
        <label htmlFor="otc-filter-maker">Filter by maker address</label>
        <input
          id="otc-filter-maker"
          type="text"
          value={filters.maker}
          onChange={(event) => onChange({ ...filters, maker: event.target.value })}
          placeholder="0x…"
          spellCheck={false}
        />
      </FilterField>
      <FilterField>
        <label htmlFor="otc-filter-order-id">Filter by order id</label>
        <input
          id="otc-filter-order-id"
          type="text"
          inputMode="numeric"
          value={filters.orderId}
          onChange={(event) => onChange({ ...filters, orderId: event.target.value })}
          placeholder="e.g. 42"
        />
      </FilterField>
    </FilterBar>
  )
}
