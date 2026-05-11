import { useEffect, useState } from 'react'

// @greg/sdk is not available in this workspace — using local mirror instead.
// See apps/frontend/apps/cowswap-frontend/src/greg/tiers.ts for details.
import { assignTier, type Tier } from '../tiers'

const REBATES_API = process.env.REACT_APP_REBATES_API ?? 'https://rebates.ophis.fi'

export interface TierStatus {
  wallet: `0x${string}`
  volume_30d_usd: number
  trade_count_30d: number
  tier: Tier
  next_tier: Tier | null
  usd_to_next_tier: number
}

export function useTier(wallet: `0x${string}` | undefined): {
  data: TierStatus | null
  loading: boolean
  error: Error | null
} {
  const [data, setData] = useState<TierStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!wallet) {
      setData(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${REBATES_API}/tier/${wallet.toLowerCase()}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`tier API ${res.status}`)
        const json = (await res.json()) as TierStatus
        if (!cancelled) setData(json)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err)
        // Local fallback so the UI is never blank: Bronze with progress to Silver.
        setData({
          wallet,
          volume_30d_usd: 0,
          trade_count_30d: 0,
          tier: assignTier(0),
          next_tier: { name: 'silver', min_usd: 5_000, rebate_pct: 0.2 },
          usd_to_next_tier: 5_000,
        })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [wallet])

  return { data, loading, error }
}
