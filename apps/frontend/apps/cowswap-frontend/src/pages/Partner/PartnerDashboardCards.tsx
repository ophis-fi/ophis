import { ReactNode, useEffect, useState } from 'react'

import { Badge, MetricCard, Section } from 'ophis/ds'

import { type RankStatus, AffiliateApiError, getRankStatus } from 'modules/affiliate'

import { formatUsd } from './Partner.utils'

import { GhostButton, MetricRow, ShareRow } from '../Affiliate/Affiliate.styled'

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
export function ReferredVolumeMetric({ lifetimeUsd, cycleUsd }: { lifetimeUsd: number; cycleUsd: number }): ReactNode {
  const [view, setView] = useState<'lifetime' | 'cycle'>('lifetime')
  const isLifetime = view === 'lifetime'
  const activeStyle = { borderColor: 'var(--cow-color-primary)', color: 'var(--cow-color-primary)' }

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
 * backend supplies neither earnings nor payout status, the panel is hidden.
 * Disabled or unconfirmed payouts do not hide available earnings. Estimated
 * earnings are labeled as estimates; paid-to-date comes from executed batches.
 */
export function PartnerEarnings({
  estimatedCurrentCycleEarningsUsd,
  paidToDateWeth,
  paidToDateUsd,
  nextPayoutAt,
  payoutStatus,
}: {
  estimatedCurrentCycleEarningsUsd?: number
  paidToDateWeth?: number
  paidToDateUsd?: number
  nextPayoutAt?: string | null
  payoutStatus?: 'disabled' | 'not-configured' | 'dry-run' | 'scheduled'
}): ReactNode {
  if (estimatedCurrentCycleEarningsUsd === undefined && paidToDateUsd === undefined && !payoutStatus) return null

  return (
    <Section id="earnings" title="Earnings">
      <MetricRow>
        <MetricCard
          label="Estimated this cycle"
          value={`~${formatUsd(estimatedCurrentCycleEarningsUsd ?? 0)}`}
          sublabel="from eligible referred volume; not yet paid"
        />
        <MetricCard
          label="Paid to date"
          value={formatUsd(paidToDateUsd ?? 0)}
          sublabel={`${formatWeth(paidToDateWeth ?? 0)} WETH`}
        />
        <MetricCard
          label="Payout status"
          value={
            payoutStatus === 'scheduled'
              ? 'Scheduled'
              : payoutStatus === 'disabled'
                ? 'Disabled'
                : payoutStatus === 'dry-run'
                  ? 'Dry run'
                  : payoutStatus === 'not-configured'
                    ? 'Not configured'
                    : 'Unconfirmed'
          }
          sublabel={
            payoutStatus === 'scheduled' && nextPayoutAt
              ? `Next cycle: ${formatDate(nextPayoutAt)}`
              : 'No payout date confirmed'
          }
        />
      </MetricRow>
      <p style={{ opacity: 0.75, fontSize: '0.9em', marginTop: 8 }}>
        Estimated earnings may differ from settled amounts. When enabled, payouts are processed monthly in WETH, subject
        to reconciliation, funding and Safe approval. A scheduled cycle is not a guaranteed payment date.
      </p>
    </Section>
  )
}
