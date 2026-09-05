import type { ReactNode } from 'react'

import { Trans, useLingui } from '@lingui/react/macro'
import { OTC_CURATED_TOKENS } from 'ophis/otc'

import { FilterBar, FilterField } from './Otc.styled'

import type { BrowseFilters } from './otcBrowseFilters.utils'

export function BrowseFilterBar({
  filters,
  onChange,
}: {
  filters: BrowseFilters
  onChange: (filters: BrowseFilters) => void
}): ReactNode {
  const { t } = useLingui()
  return (
    <FilterBar>
      <FilterField>
        <label htmlFor="otc-filter-token">
          <Trans>Filter by token</Trans>
        </label>
        <select
          id="otc-filter-token"
          value={filters.token}
          onChange={(event) => onChange({ ...filters, token: event.target.value })}
        >
          <option value="">
            <Trans>All tokens</Trans>
          </option>
          {OTC_CURATED_TOKENS.map((token) => (
            <option key={token.address} value={token.address}>
              {token.symbol}
            </option>
          ))}
        </select>
      </FilterField>
      <FilterField>
        <label htmlFor="otc-filter-maker">
          <Trans>Filter by maker address</Trans>
        </label>
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
        <label htmlFor="otc-filter-order-id">
          <Trans>Filter by order id</Trans>
        </label>
        <input
          id="otc-filter-order-id"
          type="text"
          inputMode="numeric"
          value={filters.orderId}
          onChange={(event) => onChange({ ...filters, orderId: event.target.value })}
          placeholder={t`e.g. 42`}
        />
      </FilterField>
    </FilterBar>
  )
}
