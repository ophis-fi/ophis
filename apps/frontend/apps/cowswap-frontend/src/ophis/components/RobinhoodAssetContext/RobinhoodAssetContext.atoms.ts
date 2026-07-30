import { atomWithQuery } from 'jotai-tanstack-query'

import { fetchRobinhoodStockAssets } from './data'

const REFRESH_MS = 5 * 60 * 1_000

export const robinhoodAssetsQueryAtom = atomWithQuery(() => ({
  queryKey: ['robinhoodStockAssets'],
  queryFn: fetchRobinhoodStockAssets,
  staleTime: REFRESH_MS,
  refetchInterval: REFRESH_MS,
  refetchOnWindowFocus: true,
}))
