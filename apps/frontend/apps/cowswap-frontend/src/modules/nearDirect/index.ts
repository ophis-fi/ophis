import { lazy } from 'react'

export const NearDirectSwap = lazy(() =>
  import('./NearDirectSwap.container').then((module) => ({ default: module.NearDirectSwap })),
)
export { useNearSwapEntry } from './useNearSwapEntry'
export const NearSwapRecovery = lazy(() =>
  import('./NearSwapRecovery.container').then((module) => ({ default: module.NearSwapRecovery })),
)
