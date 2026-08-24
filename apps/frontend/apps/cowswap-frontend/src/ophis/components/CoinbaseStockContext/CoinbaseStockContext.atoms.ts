import { atomWithQuery } from 'jotai-tanstack-query'

import { fetchCoinbaseStockAssets } from './data'

const REFRESH_MS = 5 * 60 * 1_000

export const coinbaseStockAssetsQueryAtom = atomWithQuery(() => ({
  queryKey: ['coinbaseStockAssets'],
  queryFn: fetchCoinbaseStockAssets,
  staleTime: REFRESH_MS,
  refetchInterval: REFRESH_MS,
  refetchOnWindowFocus: true,
}))
