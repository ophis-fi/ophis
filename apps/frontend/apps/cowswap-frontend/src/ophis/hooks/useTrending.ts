/**
 * Hook: trending tokens for the current chain, fetched DIRECTLY from GeckoTerminal
 * in the browser (see geckoTerminal.ts for why — the old CF Pages Function proxy is
 * persistently throttled on Cloudflare's shared egress IP). Polls on an interval so
 * the panel stays live, abortable, and fails soft to an empty list.
 */
import { useEffect, useRef, useState } from 'react'

import { fetchTrending, GECKO_NETWORK, type TrendingToken } from './geckoTerminal'

// Re-exported so existing consumers (OphisTrending) keep importing the type from here.
export type { TrendingToken } from './geckoTerminal'

export interface TrendingState {
  status: 'idle' | 'loading' | 'ok' | 'error'
  tokens: TrendingToken[]
}

const REFRESH_MS = 45_000

export function useTrending(chainId: number | undefined): TrendingState {
  const [state, setState] = useState<TrendingState>({ status: 'idle', tokens: [] })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!chainId) {
      setState({ status: 'idle', tokens: [] })
      return
    }
    const network = GECKO_NETWORK[chainId]
    // Chain GeckoTerminal doesn't serve → nothing to show (panel hides), no polling.
    if (!network) {
      setState({ status: 'ok', tokens: [] })
      return
    }
    let cancelled = false
    // Chain changed (this effect re-ran) → drop the previous chain's tokens at once, so a
    // stale row from the old chain can never be shown — or tapped, which would prefill the
    // swap with a wrong-chain token address — while the new chain loads or if its fetch
    // fails. The 45s poll below keeps the list across SAME-chain refreshes (no reset there).
    setState({ status: 'loading', tokens: [] })

    const load = async (): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      // Keep showing the current list while refreshing; only show "loading" on the
      // first fetch for this chain.
      setState((s) => ({ ...s, status: s.tokens.length ? s.status : 'loading' }))
      try {
        const tokens = await fetchTrending(network, controller.signal)
        if (cancelled) return
        setState({ status: 'ok', tokens })
      } catch {
        // Upstream throttle / network / timeout → keep the last list, mark error.
        if (!cancelled && !controller.signal.aborted) setState((s) => ({ status: 'error', tokens: s.tokens }))
      }
    }

    load()
    const id = setInterval(load, REFRESH_MS)
    return () => {
      cancelled = true
      clearInterval(id)
      abortRef.current?.abort()
    }
  }, [chainId])

  return state
}
