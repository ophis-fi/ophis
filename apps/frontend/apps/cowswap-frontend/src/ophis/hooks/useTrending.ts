/**
 * Hook: trending tokens for the current chain, from the CF Pages Function
 * /api/trending (which proxies + caches GeckoTerminal). Polls on an interval so
 * the panel stays live, abortable, and fails soft to an empty list.
 */
import { useEffect, useRef, useState } from 'react'

export interface TrendingToken {
  symbol: string
  name: string
  address: string
  priceUsd: number
  /** 1h price change in percent. */
  change1h: number
  logo: string | null
}

type TrendingApiResponse =
  | { ok: true; data: { network: string; tokens: TrendingToken[] } }
  | { ok: false; error: { code: string; message: string } }

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
    let cancelled = false

    const load = async (): Promise<void> => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller
      // Keep showing the current list while refreshing; only show "loading" on the
      // first fetch for this chain.
      setState((s) => ({ ...s, status: s.tokens.length ? s.status : 'loading' }))
      try {
        const res = await fetch(`/api/trending?chainId=${chainId}`, { signal: controller.signal })
        if (cancelled) return
        const body = (await res.json()) as TrendingApiResponse
        if (!body.ok || !Array.isArray(body.data?.tokens)) {
          setState((s) => ({ status: 'error', tokens: s.tokens }))
          return
        }
        setState({ status: 'ok', tokens: body.data.tokens })
      } catch {
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
