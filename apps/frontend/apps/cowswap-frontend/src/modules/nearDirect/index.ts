import { lazy } from 'react'

export const NearDirectSwap = lazy(() =>
  import('./NearDirectSwap.container').then((module) => ({ default: module.NearDirectSwap })),
)
export { ModeButtons } from './nearDirect.styled'
