export { useVolumeFee } from './hooks/useVolumeFee'
export { useVolumeFeeTooltip } from './hooks/useVolumeFeeTooltip'
export type { VolumeFeeTooltip } from './hooks/useVolumeFeeTooltip'
export { volumeFeeAtom, widgetPartnerFeeAtom } from './state/volumeFeeAtom'
export {
  isBoostedPair,
  isCorrelatedPair,
  isStableStablePair,
  resolveVolumeFeeForPair,
} from './pure/resolveVolumeFeeForPair'
export type { VolumeFeeContext, VolumeFeePair } from './pure/resolveVolumeFeeForPair'
export * from './types'
