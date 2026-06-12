import { ReactNode, useEffect, useState } from 'react'

import { Badge, MetricCard, Section } from 'ophis/ds'

import { type RankStatus, AffiliateApiError, getRankStatus } from 'modules/affiliate'

import { GhostButton, MetricRow, ShareRow } from '../Affiliate/Affiliate.styled'

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

function formatWeth(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  return value.toFixed(4)
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime())
    ? '-'
    : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
}

function titleCase(name: string): string {
  return name.length ? name[0]!.toUpperCase() + name.slice(1) : name
}

/**
 * The partner's own TRADER volume tier (GET /rank), distinct from their partner
 * referral rate. Rendered as a small, clearly-labeled chip so the two are not
 * confused. Secondary, so it stays hidden while loading or on any non-404 error
 * rather than showing a spinner or error in the program header.
 */
export function PartnerTraderRank({ account }: { account: string }): ReactNode {
  const [data, setData] = useState<RankStatus | null>(null)

  useEffect(() => {
    const signal = { cancelled: false }
    // Clear any prior wallet's rank up front so an account change never leaves a
    // stale chip showing while the new fetch is in flight, or if it fails non-404.
    setData(null)
    getRankStatus(account)
      .then((res) => {
        if (!signal.cancelled) setData(res)
      })
      .catch((error: unknown) => {
        // 404 = no indexed volume yet: show Unranked. Any other error leaves data
        // null (cleared above), so the chip stays hidden.
        if (!signal.cancelled && error instanceof AffiliateApiError && error.status === 404) {
          setData({
            wallet: account.toLowerCase(),
            tier: 'none',
            volume30dUsd: 0,
            rebatePct: 0,
            nextTier: 'bronze',
            nextThresholdUsd: 20_000,
            toNextUsd: 20_000,
            position: null,
          })
        }
      })
    return () => {
      signal.cancelled = true
    }
  }, [account])

  if (!data) return null
  const tierLabel = data.tier === 'none' ? 'Unranked' : titleCase(data.tier)
  return (
    <Badge tone={data.tier === 'none' ? 'draft' : 'live'}>
      Trader rank: {tierLabel} : 30d {formatUsd(data.volume30dUsd)}
    </Badge>
  )
}

/**
 * Referred-volume metric with a lifetime / current-cycle toggle.
 * currentCycleVolumeUsd is already in the /partner payload; the toggle matches
 * how regular affiliates see cycle volume on the Profile.
 */
export function ReferredVolumeMetric({
  lifetimeUsd,
  cycleUsd,
}: {
  lifetimeUsd: number
  cycleUsd: number
}): ReactNode {
  const [view, setView] = useState<'lifetime' | 'cycle'>('lifetime')
  const isLifetime = view === 'lifetime'
  const activeStyle = { borderColor: '#f2a63e', color: '#f2a63e' }

  return (
    <div>
      <MetricCard
        label="Referred volume"
        value={formatUsd(isLifetime ? lifetimeUsd : cycleUsd)}
        sublabel={isLifetime ? 'lifetime' : 'this cycle'}
      />
      <ShareRow style={{ marginTop: 8 }}>
        <GhostButton type="button" onClick={() => setView('lifetime')} style={isLifetime ? activeStyle : undefined}>
          Lifetime
        </GhostButton>
        <GhostButton type="button" onClick={() => setView('cycle')} style={isLifetime ? undefined : activeStyle}>
          This cycle
        </GhostButton>
      </ShareRow>
    </div>
  )
}

/**
 * Earnings panel. These fields ship with a newer rebate-indexer, so if the
 * backend has not been updated yet (nextPayoutAt absent) the panel is hidden
 * rather than rendering blanks. Estimated earnings are volume-derived and
 * clearly labeled as an estimate; paid-to-date is exact.
 */
export function PartnerEarnings({
  estimatedCurrentCycleEarningsUsd,
  paidToDateWeth,
  paidToDateUsd,
  nextPayoutAt,
}: {
  estimatedCurrentCycleEarningsUsd?: number
  paidToDateWeth?: number
  paidToDateUsd?: number
  nextPayoutAt?: string
}): ReactNode {
  if (!nextPayoutAt) return null

  return (
    <Section id="earnings" title="Earnings">
      <MetricRow>
        <MetricCard
          label="Estimated this cycle"
          value={`~${formatUsd(estimatedCurrentCycleEarningsUsd ?? 0)}`}
          sublabel="from referred volume, settles in WETH"
        />
        <MetricCard
          label="Paid to date"
          value={formatUsd(paidToDateUsd ?? 0)}
          sublabel={`${formatWeth(paidToDateWeth ?? 0)} WETH`}
        />
        <MetricCard label="Next payout" value={formatDate(nextPayoutAt)} sublabel="1st of the month" />
      </MetricRow>
      <p style={{ opacity: 0.75, fontSize: '0.9em', marginTop: 8 }}>
        Estimated earnings are derived from referred volume and may differ from the settled amount.
        Payouts run monthly in WETH.
      </p>
    </Section>
  )
}
