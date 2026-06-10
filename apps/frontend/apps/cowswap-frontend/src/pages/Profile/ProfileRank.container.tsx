/**
 * ProfileRank — the rank chip + tier card for the Profile page.
 *
 * The RANK is the existing rebate Tier (apps/rebate-indexer/src/tiers.ts):
 * none / bronze / silver / gold / palladium / platinum, keyed on 30-day USD
 * volume. Fetches GET /tier/:account (JSON path) for the connected wallet and
 * renders a compact "Bronze : 30d $X : $Y to Silver" chip plus the rebate %
 * for the tier and a one-line "paid monthly in WETH" note.
 *
 * Falls back gracefully: an unindexed / never-traded wallet (404 or zeroed
 * payload) reads as "Unranked" with progress to Bronze. No partner-tier
 * surface here — this is the public volume-tier rank only.
 */
import { ReactNode, useEffect, useState } from 'react'

import { Badge, Callout, MetricCard, Section } from 'ophis/ds'

import { type RankStatus, AffiliateApiError, getRankStatus } from 'modules/affiliate'

function titleCase(name: string): string {
  return name.length ? name[0]!.toUpperCase() + name.slice(1) : name
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '$0'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
}

// Local fallback rank so the card is never blank for a wallet the indexer has
// not seen yet: Unranked, with progress to Bronze ($20k 30-day volume).
function unrankedFallback(wallet: string): RankStatus {
  return {
    wallet: wallet.toLowerCase(),
    tier: 'none',
    volume30dUsd: 0,
    rebatePct: 0,
    nextTier: 'bronze',
    nextThresholdUsd: 20_000,
    toNextUsd: 20_000,
    position: null,
  }
}

interface Props {
  account: string
}

export function ProfileRank({ account }: Props): ReactNode {
  const [data, setData] = useState<RankStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    const signal = { cancelled: false }
    setLoading(true)
    setLoadError(false)
    getRankStatus(account)
      .then((res) => {
        if (!signal.cancelled) setData(res)
      })
      .catch((error: unknown) => {
        if (signal.cancelled) return
        // 404 = wallet has no indexed volume: a normal empty state, render the
        // Unranked fallback rather than an error.
        if (error instanceof AffiliateApiError && error.status === 404) {
          setData(unrankedFallback(account))
        } else {
          setLoadError(true)
        }
      })
      .finally(() => {
        if (!signal.cancelled) setLoading(false)
      })
    return () => {
      signal.cancelled = true
    }
  }, [account])

  if (loading) {
    return (
      <Section id="rank" title="Rank">
        <p>Loading your rank...</p>
      </Section>
    )
  }

  if (loadError || !data) {
    return (
      <Section id="rank" title="Rank">
        <Callout tone="warning" title="Could not load your rank">
          <p>The rebate service did not respond. Refresh the page to try again.</p>
        </Callout>
      </Section>
    )
  }

  const isTopTier = data.tier === 'platinum' || data.nextTier == null
  const tierLabel = data.tier === 'none' ? 'Unranked' : titleCase(data.tier)
  const rebatePctLabel = `${Math.round(data.rebatePct * 100)}%`
  const chipText = isTopTier
    ? `${tierLabel} : 30d ${formatUsd(data.volume30dUsd)} : Top tier reached`
    : `${tierLabel} : 30d ${formatUsd(data.volume30dUsd)} : ${formatUsd(data.toNextUsd ?? 0)} to ${titleCase(
        data.nextTier ?? '',
      )}`

  return (
    <Section id="rank" title="Rank">
      <div style={{ marginBottom: 14 }}>
        <Badge tone={data.tier === 'none' ? 'draft' : 'live'}>{chipText}</Badge>
      </div>
      <MetricCard
        label="Rebate rate"
        value={rebatePctLabel}
        sublabel="of the rebate pool weight for your tier, paid monthly in WETH"
        compact
      />
    </Section>
  )
}
