import { useEffect, useState } from 'react'

// @ophis/sdk is not available in this workspace — using local mirror instead.
// See apps/frontend/apps/cowswap-frontend/src/ophis/tiers.ts for details.
import { assignTier, type Tier } from '../tiers'

import { useRebatesOptIn } from './useRebatesOptIn'

const REBATES_API = process.env.REACT_APP_REBATES_API ?? 'https://rebates.ophis.fi'

export interface TierStatus {
  wallet: `0x${string}`
  volume_30d_usd: number
  trade_count_30d: number
  tier: Tier
  next_tier: Tier | null
  usd_to_next_tier: number
}

export interface UseTierResult {
  data: TierStatus | null
  loading: boolean
  error: Error | null
  // Reflects the localStorage opt-in. False ⇒ no network call is made
  // and `data` is null. UI surfaces this with an opt-in CTA.
  optedIn: boolean
}

// A tier from the rebates API must match the canonical enum AND carry finite
// numerics before TierChip uses tier.name as a CSS-module class key and renders
// tier.min_usd / tier.rebate_pct. A misbehaving/compromised first-party API
// returning e.g. { tier: { name: '__proto__' } } would otherwise pass the old
// string-only check, skip the Bronze fallback, and render an unstyled chip with
// arbitrary text. (audit P3)
const VALID_TIER_NAMES: readonly string[] = ['none', 'bronze', 'silver', 'gold', 'palladium', 'platinum']
function isValidTier(t: unknown): t is Tier {
  if (typeof t !== 'object' || t === null) return false
  const o = t as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    VALID_TIER_NAMES.includes(o.name) &&
    typeof o.min_usd === 'number' &&
    Number.isFinite(o.min_usd) &&
    typeof o.rebate_pct === 'number' &&
    Number.isFinite(o.rebate_pct)
  )
}

// Phase 3 audit M (2026-05-19): tier fetch is now gated behind an explicit
// localStorage opt-in (see useRebatesOptIn.ts). When `optedIn === false`,
// this hook MUST NOT issue any network request — TierChip will render its
// opt-in placeholder instead. Verified by useTier.test.ts.
export function useTier(wallet: `0x${string}` | undefined): UseTierResult {
  const [data, setData] = useState<TierStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const optedIn = useRebatesOptIn()

  useEffect(() => {
    if (!wallet || !optedIn) {
      // Clear any stale data from a previous opted-in session so the chip
      // doesn't keep showing a tier after the user revoked consent.
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${REBATES_API}/tier/${encodeURIComponent(wallet.toLowerCase())}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`tier API ${res.status}`)
        const json = (await res.json()) as Partial<TierStatus>
        // A malformed 2xx (e.g. `{}`) must fall back to the local default (the
        // catch below: tier none/Unranked, with progress to Bronze), not crash
        // render — TierChip dereferences these fields.
        if (
          typeof json?.volume_30d_usd !== 'number' ||
          !Number.isFinite(json.volume_30d_usd) ||
          !isValidTier(json?.tier) ||
          (json.next_tier != null && !isValidTier(json.next_tier)) ||
          (json.next_tier != null &&
            (typeof json.usd_to_next_tier !== 'number' || !Number.isFinite(json.usd_to_next_tier)))
        ) {
          throw new Error('malformed tier response')
        }
        if (!cancelled) setData(json as TierStatus)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err)
        // Local fallback so the UI is never blank: Unranked with progress to Bronze.
        setData({
          wallet,
          volume_30d_usd: 0,
          trade_count_30d: 0,
          tier: assignTier(0),
          next_tier: { name: 'bronze', min_usd: 20_000, rebate_pct: 0.1 },
          usd_to_next_tier: 20_000,
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wallet, optedIn])

  return { data, loading, error, optedIn }
}
