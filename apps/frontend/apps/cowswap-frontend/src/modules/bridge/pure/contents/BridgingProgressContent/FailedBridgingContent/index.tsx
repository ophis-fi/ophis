import { ReactNode } from 'react'

import RefundIcon from '@cowprotocol/assets/cow-swap/icon-refund.svg'
import { RECEIVED_LABEL } from '@cowprotocol/common-const'
import { ExternalLink } from '@cowprotocol/ui'

import { Trans, useLingui } from '@lingui/react/macro'

import { ConfirmDetailsItem, ReceiveAmountTitle } from 'modules/trade'

import { AnimatedEllipsis, DangerText, InfoTextBold, InfoTextSpan } from '../../../../styles'
import { StyledAnimatedTimelineRefundIcon } from '../../styled'

export function FailedBridgingContent({
  needsRecovery,
  recoveryUrl,
}: {
  needsRecovery?: boolean
  recoveryUrl?: string
}): ReactNode {
  const { i18n } = useLingui()

  if (needsRecovery)
    return (
      <ConfirmDetailsItem label={i18n._(RECEIVED_LABEL)} withTimelineDot>
        <DangerText>
          <Trans>Automatic refund unavailable. Open the Relay transaction for recovery and support.</Trans>
        </DangerText>
        {recoveryUrl && (
          <ExternalLink href={recoveryUrl}>
            <Trans>View Relay transaction</Trans>
          </ExternalLink>
        )}
      </ConfirmDetailsItem>
    )

  return (
    <>
      <ConfirmDetailsItem label={i18n._(RECEIVED_LABEL)} withTimelineDot>
        <DangerText>
          <Trans>Bridging failed</Trans>
        </DangerText>
      </ConfirmDetailsItem>
      <ConfirmDetailsItem
        label={
          <ReceiveAmountTitle icon={<StyledAnimatedTimelineRefundIcon src={RefundIcon} />}>
            <InfoTextSpan>
              <b>
                <Trans>Refunding</Trans>
              </b>
            </InfoTextSpan>
          </ReceiveAmountTitle>
        }
      >
        <InfoTextBold>
          <Trans>Refund started</Trans>
          <AnimatedEllipsis isVisible />
        </InfoTextBold>
      </ConfirmDetailsItem>
    </>
  )
}
