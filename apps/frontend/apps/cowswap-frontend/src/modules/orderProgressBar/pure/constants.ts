import { UI } from '@cowprotocol/ui'

import { OrderProgressBarProps } from '../types'

export type BgColorMap = Record<NonNullable<StepName>, string | undefined>
export type StepName = OrderProgressBarProps['stepName']
export type PaddingMap = Record<NonNullable<StepName>, string | undefined>
export type GapMap = Record<NonNullable<StepName>, string | undefined>

// Ophis: the lifecycle panel backgrounds previously used the CoW cyan
// (--cow-color-blue-300-primary), which is off-brand in light mode (dark mode
// was already overridden to cosmic). The de-branded states are left undefined so
// they fall through to the neutral, theme-aware COLOR_PAPER_DARKER default in
// ProgressImageWrapper, matching the bridge states below.
export const PROCESS_IMAGE_WRAPPER_BG_COLOR: BgColorMap = {
  initial: undefined,
  unfillable: '#FFDB9C',
  delayed: undefined,
  submissionFailed: undefined,
  solved: undefined,
  solving: undefined,
  finished: undefined,
  cancellationFailed: undefined,
  executing: undefined,
  cancelling: '#f0dede',
  cancelled: '#f0dede',
  expired: `var(${UI.COLOR_ALERT_BG})`,
  bridgingFinished: undefined,
  bridgingFailed: undefined,
  bridgingInProgress: undefined,
  refundCompleted: undefined,
}
