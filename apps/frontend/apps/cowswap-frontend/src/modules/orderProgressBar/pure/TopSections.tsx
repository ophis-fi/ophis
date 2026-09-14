import { ReactNode } from 'react'

import { ProductLogo, ProductVariant, UI } from '@cowprotocol/ui'

import { t } from '@lingui/core/macro'
import { OphieMark } from 'ophis/components/OphieMark'
import { OphieSpinner } from 'ophis/components/OphieSpinner'
import { AlertTriangle, Clock, XCircle } from 'react-feather'

import { NoSurplus, ShowSurplus } from './BenefitComponents'
import { PROCESS_IMAGE_WRAPPER_BG_COLOR } from './constants'
import { ProgressImageWrapper } from './ProgressImageWrapper'
import { AnimatedTokens } from './steps/AnimatedToken'
import { CircularCountdown } from './steps/CircularCountdown'
import * as styledEl from './styled'

import { OrderProgressBarProps } from '../types'

interface BaseTopSectionProps {
  stepName: OrderProgressBarProps['stepName']
}

interface InitialTopSectionProps extends BaseTopSectionProps {
  order: OrderProgressBarProps['order']
}

export function InitialTopSection({ stepName, order }: InitialTopSectionProps): ReactNode {
  return (
    <ProgressImageWrapper stepName={stepName}>
      <AnimatedTokens sellToken={order?.inputToken} buyToken={order?.outputToken} />
    </ProgressImageWrapper>
  )
}

export function UnfillableTopSection(): ReactNode {
  return (
    <styledEl.ProgressArt>
      <AlertTriangle size={64} aria-label={t`Order out of market`} />
    </styledEl.ProgressArt>
  )
}

export function DelayedSolvedSubmissionFailedTopSection(): ReactNode {
  return (
    <styledEl.ProgressArt>
      <OphieSpinner size={72} pace="slow" />
    </styledEl.ProgressArt>
  )
}

interface SolvingTopSectionProps {
  countdown: number
}

export function SolvingTopSection({ countdown }: SolvingTopSectionProps): ReactNode {
  return (
    <styledEl.ProgressArt>
      <CircularCountdown
        countdown={countdown || 0}
        isDelayed={countdown === 0}
        bgColor={PROCESS_IMAGE_WRAPPER_BG_COLOR.solving}
      />
      <OphieMark size={64} />
    </styledEl.ProgressArt>
  )
}

export function ExecutingTopSection({ stepName }: BaseTopSectionProps): ReactNode {
  return (
    <ProgressImageWrapper stepName={stepName}>
      <styledEl.ProgressArt>
        <OphieSpinner size={72} />
      </styledEl.ProgressArt>
    </ProgressImageWrapper>
  )
}

interface FinishedCancellationFailedTopSectionProps extends BaseTopSectionProps {
  order: OrderProgressBarProps['order']
  shouldShowSurplus?: boolean | null
  surplusPercentValue: string
  randomBenefit: string
}

export function FinishedCancellationFailedTopSection({
  stepName,
  order,
  shouldShowSurplus,
  surplusPercentValue,
  randomBenefit,
}: FinishedCancellationFailedTopSectionProps): ReactNode {
  return (
    <ProgressImageWrapper stepName={stepName}>
      <styledEl.FinishedImageContent>
        <styledEl.FinishedTagLine>
          {shouldShowSurplus ? (
            <ShowSurplus
              order={order}
              shouldShowSurplus={shouldShowSurplus}
              surplusPercentValue={surplusPercentValue}
            />
          ) : (
            <NoSurplus randomBenefit={randomBenefit} />
          )}
        </styledEl.FinishedTagLine>
        <styledEl.FinishedLogo>
          <ProductLogo
            variant={ProductVariant.CowSwap}
            theme="light"
            overrideColor={UI.COLOR_TEXT}
            height={19}
            logoIconOnly
          />
          <b>Ophis</b>
        </styledEl.FinishedLogo>
      </styledEl.FinishedImageContent>
    </ProgressImageWrapper>
  )
}

export function CancelledCancellingTopSection({ stepName }: BaseTopSectionProps): ReactNode {
  return (
    <ProgressImageWrapper stepName={stepName}>
      <styledEl.ProgressArt>
        <XCircle size={64} aria-label={t`Cancelling order`} />
      </styledEl.ProgressArt>
    </ProgressImageWrapper>
  )
}

export function ExpiredTopSection({ stepName }: BaseTopSectionProps): ReactNode {
  return (
    <ProgressImageWrapper stepName={stepName}>
      <styledEl.ProgressArt>
        <Clock size={64} aria-label={t`Order expired`} />
      </styledEl.ProgressArt>
    </ProgressImageWrapper>
  )
}
