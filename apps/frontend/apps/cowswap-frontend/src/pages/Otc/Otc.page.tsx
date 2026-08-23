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

import { Trans, useLingui } from '@lingui/react/macro'
import { Badge, Callout, PageShell } from 'ophis/ds'
import { useOtcData } from 'ophis/otc'
import { OtcCreatePanel } from 'ophis/otcWrite'
import { Navigate } from 'react-router'

import { Routes as RoutesEnum } from 'common/constants/routes'

import { BadgeRow, TabBar, TabButton } from './Otc.styled'
import { OtcDisclosure } from './OtcDisclosure'
import { buildOtcDisplayRows, filterBrowseRows } from './otcDisplay'
import { BrowsePanel, MyOrdersPanel, OtcStateNotices, ReadOnlyCreatePanel } from './OtcPagePanels'
import { useOtcNow } from './useOtcNow'
import { useOtcPageEnabled, useOtcWriteEnabled } from './useOtcPageEnabled'

import type { OtcDataState } from 'ophis/otc'

type OtcTab = 'browse' | 'mine' | 'create'

const TABS: readonly OtcTab[] = ['browse', 'mine', 'create']

function OtcTabLabel({ tab }: { tab: OtcTab }): ReactNode {
  if (tab === 'browse') return <Trans>Browse</Trans>
  if (tab === 'mine') return <Trans>My orders</Trans>
  return <Trans>Create</Trans>
}

export interface OtcPageViewProps {
  state: OtcDataState
  account: string | undefined
  nowMs: number
  createPanel?: ReactNode
  writeEnabled?: boolean
}

export function OtcPageView({ state, account, nowMs, createPanel, writeEnabled = false }: OtcPageViewProps): ReactNode {
  const { t } = useLingui()
  const [tab, setTab] = useState<OtcTab>(writeEnabled ? 'create' : 'browse')
  const rows = buildOtcDisplayRows(state)
  const dataReady = state.status === 'ready' || state.status === 'degraded'
  const showTabs = dataReady || writeEnabled
  const verifiedBlock = state.snapshot?.blockNumber.toString() ?? null

  return (
    <PageShell
      width="wide"
      eyebrow="OTC"
      title={<Trans>Fixed-price peer-to-peer orders.</Trans>}
      lede={
        writeEnabled ? (
          <Trans>
            Test exact ERC-20 escrow actions against a local Ethereum fork. Every order read is verified directly
            against the pinned contract.
          </Trans>
        ) : (
          <Trans>
            Browse escrowed OTC orders settled on an external immutable Ethereum contract. This surface is read-only;
            order data is verified directly against Ethereum.
          </Trans>
        )
      }
    >
      <BadgeRow>
        <Badge tone="live">Ethereum</Badge>
        <Badge tone="beta">{writeEnabled ? <Trans>Local fork writes</Trans> : <Trans>Read-only</Trans>}</Badge>
        {verifiedBlock && (
          <span aria-label={t`Verified at block ${verifiedBlock}`}>
            <Trans>Verified at block {verifiedBlock}</Trans>
          </span>
        )}
      </BadgeRow>

      <OtcDisclosure />

      {state.status === 'loading' && (
        <p role="status">
          <Trans>Loading OTC orders from Ethereum...</Trans>
        </p>
      )}

      {state.status === 'unavailable' && (
        <Callout tone="warning" title={<Trans>OTC data unavailable</Trans>}>
          <p>
            <Trans>
              On-chain verification failed, so order data is hidden rather than shown unverified. Refresh to try again.
            </Trans>
          </p>
        </Callout>
      )}

      {showTabs && (
        <>
          {dataReady && <OtcStateNotices state={state} />}
          <TabBar role="group" aria-label={t`OTC views`}>
            {TABS.map((item) => (
              <TabButton
                key={item}
                type="button"
                $active={tab === item}
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
              >
                <OtcTabLabel tab={item} />
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
