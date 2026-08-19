/**
 * OtcPage — read-only Ethereum OTC surface (OTC Milestone B).
 *
 * Browse and inspect fixed-price escrow orders on the external immutable
 * Swapboard contract. STRICTLY READ-ONLY: no transaction selector is
 * reachable from this page family (enforced by ophis/otc's boundary test and
 * the empty enabled-selector manifest pin). Write flows are a separate,
 * approval-gated milestone.
 *
 * Data flow: on-chain snapshot (settlement authority, fail-closed) +
 * subgraph enrichment (ages/history, optional). Rows are labeled
 * "Verified on-chain" only after direct reconciliation.
 *
 * AGENTS.md compliance: named exports, page logic in *.page.tsx with a pure
 * view (OtcPageView) testable without hooks.
 */
import { useState, type ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, PageShell, Section } from 'ophis/ds'
import { useOtcData } from 'ophis/otc'
import { Navigate } from 'react-router'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { BadgeRow, DisabledAction, FilterBar, FilterField, TabBar, TabButton } from './Otc.styled'
import { OtcDisclosure } from './OtcDisclosure'
import { buildOtcDisplayRows, filterBrowseRows, filterMakerRows } from './otcDisplay'
import { OtcOrdersTable } from './OtcOrdersTable'
import { useOtcPageEnabled } from './useOtcPageEnabled'

import type { OtcDisplayRow } from './otcDisplay'
import type { OtcDataState } from 'ophis/otc'

type OtcTab = 'browse' | 'mine' | 'create'

const TABS: ReadonlyArray<{ id: OtcTab; label: string }> = [
  { id: 'browse', label: 'Browse' },
  { id: 'mine', label: 'My orders' },
  { id: 'create', label: 'Create' },
]

interface BrowseFilters {
  token: string
  maker: string
  orderId: string
}

function applyBrowseFilters(rows: OtcDisplayRow[], filters: BrowseFilters): OtcDisplayRow[] {
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

function BrowseFilterBar({
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
          <option value="0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2">WETH</option>
          <option value="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48">USDC</option>
          <option value="0x6B175474E89094C44Da98b954EedeAC495271d0F">DAI</option>
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

function BrowsePanel({ rows, nowMs }: { rows: OtcDisplayRow[]; nowMs: number }): ReactNode {
  const [filters, setFilters] = useState<BrowseFilters>({ token: '', maker: '', orderId: '' })
  const filtered = applyBrowseFilters(rows, filters)

  return (
    <Section id="otc-browse" title="Active orders">
      <BrowseFilterBar filters={filters} onChange={setFilters} />
      {filtered.length === 0 ? (
        <Callout tone="info" title="No active orders">
          <p>No active orders match. Clear the filters or check back later.</p>
        </Callout>
      ) : (
        <OtcOrdersTable rows={filtered} nowMs={nowMs} caption="Active OTC orders" />
      )}
    </Section>
  )
}

function MyOrdersPanel({
  rows,
  account,
  nowMs,
}: {
  rows: OtcDisplayRow[]
  account: string | undefined
  nowMs: number
}): ReactNode {
  if (!account) {
    return (
      <Section id="otc-mine" title="My orders">
        <Callout tone="info" title="No wallet connected">
          <p>Connect a wallet to see your orders. Viewing is read-only; connecting does not enable transactions.</p>
        </Callout>
      </Section>
    )
  }

  const mine = filterMakerRows(rows, account)
  return (
    <Section id="otc-mine" title="My orders">
      {mine.length === 0 ? (
        <Callout tone="info" title="No orders for this wallet">
          <p>This wallet has not created any OTC orders on the escrow contract.</p>
        </Callout>
      ) : (
        <OtcOrdersTable rows={mine} nowMs={nowMs} caption="Orders created by the connected wallet" />
      )}
    </Section>
  )
}

function CreatePanel(): ReactNode {
  return (
    <Section id="otc-create" title="Create">
      <Callout tone="info" title="Order creation is not enabled">
        <p>
          Creating, filling, and cancelling orders through Ophis is a later, separately reviewed milestone. This preview
          is read-only by construction: no transaction can be built or signed from this page.
        </p>
      </Callout>
      <DisabledAction type="button" disabled aria-disabled="true">
        Order creation is not yet enabled
      </DisabledAction>
    </Section>
  )
}

function OtcStateNotices({ state }: { state: OtcDataState }): ReactNode {
  if (state.status === 'degraded') {
    return (
      <Callout tone="warning" title="Index data unavailable or stale">
        <p>Ages and history are hidden. On-chain state below remains authoritative and current.</p>
      </Callout>
    )
  }
  if (state.snapshot?.truncated) {
    return (
      <Callout tone="info" title="Showing the most recent orders">
        <p>Older orders beyond the latest {state.snapshot.orders.length} are not listed here.</p>
      </Callout>
    )
  }
  return null
}

export interface OtcPageViewProps {
  state: OtcDataState
  account: string | undefined
  nowMs: number
}

export function OtcPageView({ state, account, nowMs }: OtcPageViewProps): ReactNode {
  const [tab, setTab] = useState<OtcTab>('browse')
  const rows = buildOtcDisplayRows(state)

  return (
    <PageShell
      width="wide"
      eyebrow="OTC"
      title="Fixed-price peer-to-peer orders."
      lede="Browse escrowed OTC orders settled on an external immutable Ethereum contract. Read-only preview: order data is verified directly against Ethereum."
    >
      <BadgeRow>
        <Badge tone="live">Ethereum</Badge>
        <Badge tone="beta">Read-only preview</Badge>
        {state.snapshot && (
          <span aria-label={`Verified at block ${state.snapshot.blockNumber.toString()}`}>
            Verified at block {state.snapshot.blockNumber.toString()}
          </span>
        )}
      </BadgeRow>

      <OtcDisclosure />

      {state.status === 'loading' && <p>Loading OTC orders from Ethereum...</p>}

      {state.status === 'unavailable' && (
        <Callout tone="warning" title="OTC data unavailable">
          <p>
            On-chain verification failed, so order data is hidden rather than shown unverified. Refresh to try again.
          </p>
        </Callout>
      )}

      {(state.status === 'ready' || state.status === 'degraded') && (
        <>
          <OtcStateNotices state={state} />
          <TabBar role="tablist" aria-label="OTC views">
            {TABS.map((item) => (
              <TabButton
                key={item.id}
                type="button"
                $active={tab === item.id}
                aria-pressed={tab === item.id}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </TabButton>
            ))}
          </TabBar>
          {tab === 'browse' && <BrowsePanel rows={filterBrowseRows(rows)} nowMs={nowMs} />}
          {tab === 'mine' && <MyOrdersPanel rows={rows} account={account} nowMs={nowMs} />}
          {tab === 'create' && <CreatePanel />}
        </>
      )}
    </PageShell>
  )
}

export function OtcPage(): ReactNode {
  const enabled = useOtcPageEnabled()
  const { account } = useWalletInfo()
  const state = useOtcData(enabled)

  if (!enabled) return <Navigate to={RoutesEnum.HOME} replace />

  // Wall-clock read for relative order ages only; refreshed on re-render.
  // eslint-disable-next-line react-hooks/purity
  return <OtcPageView state={state} account={account} nowMs={Date.now()} />
}
