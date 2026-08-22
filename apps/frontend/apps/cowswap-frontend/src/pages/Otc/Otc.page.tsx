/**
 * OtcPage — Ethereum OTC surface (Milestone B read-only; C fork writes).
 *
 * Browse and inspect fixed-price escrow orders on the external immutable
 * Swapboard contract. Production remains strictly read-only. The optional
 * Milestone C surface is mounted only when the separate local-fork write gate
 * passes; all signer access stays isolated in ophis/otcWrite.
 *
 * Data flow: on-chain snapshot (settlement authority, fail-closed) +
 * subgraph enrichment (ages/history, optional). Rows are labeled
 * "Verified on-chain" only after direct reconciliation.
 *
 * AGENTS.md compliance: named exports, page logic in *.page.tsx with a pure
 * view (OtcPageView) testable without hooks.
 */
import { useCallback, useState, type ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, PageShell, Section } from 'ophis/ds'
import { useOtcData } from 'ophis/otc'
import { OtcCreatePanel } from 'ophis/otcWrite'
import { Navigate } from 'react-router'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { BadgeRow, DisabledAction, TabBar, TabButton } from './Otc.styled'
import { applyBrowseFilters, BrowseFilterBar, EMPTY_BROWSE_FILTERS, type BrowseFilters } from './OtcBrowseFilters'
import { OtcDisclosure } from './OtcDisclosure'
import { buildOtcDisplayRows, filterBrowseRows, filterMakerRows } from './otcDisplay'
import { OtcOrdersTable } from './OtcOrdersTable'
import { useOtcNow } from './useOtcNow'
import { useOtcPageEnabled, useOtcWriteEnabled } from './useOtcPageEnabled'

import type { OtcDisplayRow } from './otcDisplay'
import type { OtcDataState } from 'ophis/otc'

type OtcTab = 'browse' | 'mine' | 'create'

const TABS: ReadonlyArray<{ id: OtcTab; label: string }> = [
  { id: 'browse', label: 'Browse' },
  { id: 'mine', label: 'My orders' },
  { id: 'create', label: 'Create' },
]

function BrowsePanel({ rows, nowMs }: { rows: OtcDisplayRow[]; nowMs: number }): ReactNode {
  const [filters, setFilters] = useState<BrowseFilters>(EMPTY_BROWSE_FILTERS)
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

function ReadOnlyCreatePanel(): ReactNode {
  return (
    <Section id="otc-create" title="Create">
      <Callout tone="info" title="Order creation is not enabled">
        <p>
          Creating, filling, and cancelling orders are under isolated Milestone C development. This production page is
          read-only: no transaction can be built or signed from it.
        </p>
      </Callout>
      <DisabledAction type="button" disabled aria-disabled="true">
        Order creation is not yet enabled
      </DisabledAction>
    </Section>
  )
}

function OtcStateNotices({ state }: { state: OtcDataState }): ReactNode {
  return (
    <div aria-live="polite">
      {state.degradedReason === 'index-unavailable' && (
        <Callout tone="warning" title="Index data unavailable">
          <p>Ages and history are hidden. On-chain state below remains authoritative and current.</p>
        </Callout>
      )}
      {state.degradedReason === 'index-stale' && (
        <Callout tone="warning" title="Index data is stale">
          <p>Ages and history may lag behind the chain. On-chain state below remains authoritative and current.</p>
        </Callout>
      )}
      {state.degradedReason === 'node-stale' && (
        <Callout tone="warning" title="Network data may be outdated">
          <p>
            This RPC node appears to be behind the network. Order states shown below were verified on-chain but may not
            reflect the latest blocks. Refresh, or try again shortly.
          </p>
        </Callout>
      )}
      {state.degradedReason === 'index-corrupt' && (
        <Callout tone="warning" title="Index data partially invalid">
          <p>
            Malformed index rows were dropped and are not shown. On-chain state below remains authoritative and current.
          </p>
        </Callout>
      )}
      {state.snapshot?.truncated && (
        <Callout tone="info" title="Showing the most recent orders">
          <p>Older orders beyond the latest {state.snapshot.orders.length} are not listed here.</p>
        </Callout>
      )}
    </div>
  )
}

export interface OtcPageViewProps {
  state: OtcDataState
  account: string | undefined
  nowMs: number
  createPanel?: ReactNode
  writeEnabled?: boolean
}

export function OtcPageView({ state, account, nowMs, createPanel, writeEnabled = false }: OtcPageViewProps): ReactNode {
  const [tab, setTab] = useState<OtcTab>(writeEnabled ? 'create' : 'browse')
  const rows = buildOtcDisplayRows(state)
  const dataReady = state.status === 'ready' || state.status === 'degraded'
  const showTabs = dataReady || writeEnabled

  return (
    <PageShell
      width="wide"
      eyebrow="OTC"
      title="Fixed-price peer-to-peer orders."
      lede={
        writeEnabled
          ? 'Test exact ERC-20 escrow actions against a local Ethereum fork. Every order read is verified directly against the pinned contract.'
          : 'Browse escrowed OTC orders settled on an external immutable Ethereum contract. This surface is read-only; order data is verified directly against Ethereum.'
      }
    >
      <BadgeRow>
        <Badge tone="live">Ethereum</Badge>
        <Badge tone="beta">{writeEnabled ? 'Local fork writes' : 'Read-only'}</Badge>
        {state.snapshot && (
          <span aria-label={`Verified at block ${state.snapshot.blockNumber.toString()}`}>
            Verified at block {state.snapshot.blockNumber.toString()}
          </span>
        )}
      </BadgeRow>

      <OtcDisclosure />

      {state.status === 'loading' && <p role="status">Loading OTC orders from Ethereum...</p>}

      {state.status === 'unavailable' && (
        <Callout tone="warning" title="OTC data unavailable">
          <p>
            On-chain verification failed, so order data is hidden rather than shown unverified. Refresh to try again.
          </p>
        </Callout>
      )}

      {showTabs && (
        <>
          {dataReady && <OtcStateNotices state={state} />}
          <TabBar role="group" aria-label="OTC views">
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
          {dataReady && tab === 'browse' && <BrowsePanel rows={filterBrowseRows(rows)} nowMs={nowMs} />}
          {dataReady && tab === 'mine' && <MyOrdersPanel rows={rows} account={account} nowMs={nowMs} />}
          {tab === 'create' && (createPanel ?? <ReadOnlyCreatePanel />)}
        </>
      )}
    </PageShell>
  )
}

export function OtcPage(): ReactNode {
  const enabled = useOtcPageEnabled()
  const writeEnabled = useOtcWriteEnabled()
  const { account } = useWalletInfo()
  const [refreshSignal, setRefreshSignal] = useState(0)
  const nowMs = useOtcNow()
  const state = useOtcData(enabled, refreshSignal)
  const refresh = useCallback(() => setRefreshSignal((current) => current + 1), [])

  if (!enabled) return <Navigate to={RoutesEnum.HOME} replace />

  return (
    <OtcPageView
      state={state}
      account={account}
      nowMs={nowMs}
      writeEnabled={writeEnabled}
      createPanel={writeEnabled ? <OtcCreatePanel onConfirmed={refresh} /> : undefined}
    />
  )
}
