import { useState, type ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { Callout, Section } from 'ophis/ds'

import { DisabledAction } from './Otc.styled'
import { BrowseFilterBar } from './OtcBrowseFilters'
import { applyBrowseFilters, EMPTY_BROWSE_FILTERS, type BrowseFilters } from './otcBrowseFilters.utils'
import { filterMakerRows } from './otcDisplay'
import { OtcOrdersTable } from './OtcOrdersTable'

import type { OtcDisplayRow } from './otcDisplay'
import type { OtcDataState } from 'ophis/otc'

export function BrowsePanel({ rows, nowMs }: { rows: OtcDisplayRow[]; nowMs: number }): ReactNode {
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_BROWSE_FILTERS)
  const filtered = applyBrowseFilters(rows, filters)

  return (
    <Section id="otc-browse" title={<Trans>Active orders</Trans>}>
      <BrowseFilterBar filters={filters} onChange={setFilters} />
      {filtered.length === 0 ? (
        <Callout tone="info" title={<Trans>No active orders</Trans>}>
          <p>
            <Trans>No active orders match. Clear the filters or check back later.</Trans>
          </p>
        </Callout>
      ) : (
        <OtcOrdersTable rows={filtered} nowMs={nowMs} caption={<Trans>Active OTC orders</Trans>} />
      )}
    </Section>
  )
}

export function MyOrdersPanel({
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
      <Section id="otc-mine" title={<Trans>My orders</Trans>}>
        <Callout tone="info" title={<Trans>No wallet connected</Trans>}>
          <p>
            <Trans>
              Connect a wallet to see your orders. Viewing is read-only; connecting does not enable transactions.
            </Trans>
          </p>
        </Callout>
      </Section>
    )
  }

  const mine = filterMakerRows(rows, account)
  return (
    <Section id="otc-mine" title={<Trans>My orders</Trans>}>
      {mine.length === 0 ? (
        <Callout tone="info" title={<Trans>No orders for this wallet</Trans>}>
          <p>
            <Trans>This wallet has not created any OTC orders on the escrow contract.</Trans>
          </p>
        </Callout>
      ) : (
        <OtcOrdersTable rows={mine} nowMs={nowMs} caption={<Trans>Orders created by the connected wallet</Trans>} />
      )}
    </Section>
  )
}

export function ReadOnlyCreatePanel(): ReactNode {
  return (
    <Section id="otc-create" title={<Trans>Create</Trans>}>
      <Callout tone="info" title={<Trans>Order creation is not enabled</Trans>}>
        <p>
          <Trans>
            Creating, filling, and cancelling orders are under isolated Milestone C development. This production page is
            read-only: no transaction can be built or signed from it.
          </Trans>
        </p>
      </Callout>
      <DisabledAction type="button" disabled aria-disabled="true">
        <Trans>Order creation is not yet enabled</Trans>
      </DisabledAction>
    </Section>
  )
}

export function OtcStateNotices({ state }: { state: OtcDataState }): ReactNode {
  const recentOrderCount = state.snapshot?.orders.length

  return (
    <div aria-live="polite">
      {state.degradedReason === 'index-unavailable' && (
        <Callout tone="warning" title={<Trans>Index data unavailable</Trans>}>
          <p>
            <Trans>Ages and history are hidden. On-chain state below remains authoritative and current.</Trans>
          </p>
        </Callout>
      )}
      {state.degradedReason === 'index-stale' && (
        <Callout tone="warning" title={<Trans>Index data is stale</Trans>}>
          <p>
            <Trans>
              Ages and history may lag behind the chain. On-chain state below remains authoritative and current.
            </Trans>
          </p>
        </Callout>
      )}
      {state.degradedReason === 'node-stale' && (
        <Callout tone="warning" title={<Trans>Network data may be outdated</Trans>}>
          <p>
            <Trans>
              This RPC node appears to be behind the network. Order states shown below were verified on-chain but may
              not reflect the latest blocks. Refresh, or try again shortly.
            </Trans>
          </p>
        </Callout>
      )}
      {state.degradedReason === 'index-corrupt' && (
        <Callout tone="warning" title={<Trans>Index data partially invalid</Trans>}>
          <p>
            <Trans>
              Malformed index rows were dropped and are not shown. On-chain state below remains authoritative and
              current.
            </Trans>
          </p>
        </Callout>
      )}
      {state.snapshot?.truncated && (
        <Callout tone="info" title={<Trans>Showing the most recent orders</Trans>}>
          <p>
            <Trans>Older orders beyond the latest {recentOrderCount} are not listed here.</Trans>
          </p>
        </Callout>
      )}
    </div>
  )
}
