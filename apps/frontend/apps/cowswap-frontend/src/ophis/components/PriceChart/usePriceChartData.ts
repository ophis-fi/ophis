import { useEffect, useState } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { getDefillamaPriceChart, PriceChartRange, PricePoint } from 'modules/usdAmount'

export interface PriceChartData {
  readonly points: readonly PricePoint[]
  readonly isLoading: boolean
}

/**
 * Fetch a token's price history for one range.
 *
 * Deliberately plain state rather than SWR: the panel is decoration, a stale
 * series is harmless, and this avoids adding a cache key that another surface
 * could accidentally share and invalidate.
 *
 * Aborts the in-flight request on unmount and on any input change, and guards
 * the setState with the same signal so a slow response for the previous range
 * cannot overwrite a newer one.
 */
export function usePriceChartData(
  chainId: SupportedChainId | undefined,
  tokenAddress: string | undefined,
  range: PriceChartRange,
): PriceChartData {
  const [points, setPoints] = useState<readonly PricePoint[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!chainId || !tokenAddress) {
      setPoints([])
      setIsLoading(false)
      return
    }

    const controller = new AbortController()
    setIsLoading(true)

    getDefillamaPriceChart(chainId, tokenAddress, range, controller.signal).then((result) => {
      // getDefillamaPriceChart never rejects, so no catch is needed; it resolves
      // to [] on abort too. The signal check keeps a late response from a
      // superseded range out of state.
      if (controller.signal.aborted) return

      setPoints(result)
      setIsLoading(false)
    })

    return () => controller.abort()
  }, [chainId, tokenAddress, range])

  return { points, isLoading }
}
