import { useEffect, useState } from 'react'

import { PATH_VIZ_CHAIN_ID } from 'modules/mevReceipt/services/fetchPathViz'

import { parsePathVizResponse, PathVizResponse } from './types'

/** "0x" + 56 bytes hex, mirrors ophis/hooks/useSettlementTxHash.ts. */
const COW_ORDER_UID_LENGTH = 114

/** Mirrors cowSdk's OPHIS_OP_ORDERBOOK_URL; pathviz is a chain-10 feature. */
const OPHIS_OP_ORDERBOOK_URL = 'https://optimism-mainnet.ophis.fi'

const ABORT_MS = 5_000

export interface PathVizGraphState {
  readonly response: PathVizResponse | null
  readonly isLoading: boolean
}

/**
 * Fetch an order's settlement route graph plus its pre-rendered SVG in ONE
 * request (`?pathVizImage=true`): the graph supplies a truthful text fallback
 * and the SVG supplies the picture. A render failure on the backend keeps the
 * 200 and simply omits `svgBase64`, which callers treat as "text only".
 *
 * Never throws, never surfaces an error: pathviz is decoration on a settled
 * order. The 404 while the backend flag is off is the expected steady state
 * until the infra PR deploys, so this hook returning null forever is a
 * supported outcome, not a bug.
 *
 * Gates: chain 10 only (the backend hardcodes the OP settlement address), and
 * the id must look like a CoW order uid. Everything else resolves to null
 * without a request.
 */
export function usePathVizGraph(chainId: number | undefined, orderUid: string | undefined): PathVizGraphState {
  const [response, setResponse] = useState<PathVizResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const enabled = chainId === PATH_VIZ_CHAIN_ID && !!orderUid && orderUid.length === COW_ORDER_UID_LENGTH

  useEffect(() => {
    if (!enabled || !orderUid) {
      setResponse(null)
      setIsLoading(false)
      return
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ABORT_MS)
    setIsLoading(true)

    fetch(`${OPHIS_OP_ORDERBOOK_URL}/api/v1/orders/${orderUid}/pathviz?pathVizImage=true`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
      .then(async (res) => (res.ok ? parsePathVizResponse(await res.json()) : null))
      .catch(() => null)
      .then((parsed) => {
        if (controller.signal.aborted) return
        setResponse(parsed)
        setIsLoading(false)
      })

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [enabled, orderUid])

  return { response, isLoading }
}
