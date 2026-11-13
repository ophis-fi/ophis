import { ReactNode } from 'react'

import CheckmarkIcon from '@cowprotocol/assets/cow-swap/checkmark.svg'
import { RECEIVED_LABEL } from '@cowprotocol/common-const'
import { ExplorerDataType, getExplorerLink, shortenAddress } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { ExternalLink, NetworkLogo } from '@cowprotocol/ui'

import { Trans, useLingui } from '@lingui/react/macro'

import { ConfirmDetailsItem, ReceiveAmountTitle } from 'modules/trade'

import { DangerText, SuccessTextBold, TimelineIconCircleWrapper } from '../../../../styles'
import { TokenAmountDisplay } from '../../../TokenAmountDisplay'
import { RefundLink, RefundRecipientWrapper, StyledTimelineCheckmarkIcon } from '../../styled'

interface RefundedContentProps {
  account: string
  bridgeSendCurrencyAmount: CurrencyAmount<Currency>
  isRelay?: boolean
  explorerUrl?: string
}

export function RefundedBridgingContent({
  account,
  bridgeSendCurrencyAmount,
  isRelay = false,
  explorerUrl,
}: RefundedContentProps): ReactNode {
  const sourceChainId = bridgeSendCurrencyAmount.currency.chainId as SupportedChainId
  const { i18n } = useLingui()

  if (isRelay)
    return (
      <ConfirmDetailsItem label={i18n._(RECEIVED_LABEL)} withTimelineDot>
        <SuccessTextBold>
          <Trans>Relay refund completed. View the Relay transaction for the refunded amount, token and network.</Trans>
        </SuccessTextBold>
        {explorerUrl && (
          <ExternalLink href={explorerUrl}>
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
          <ReceiveAmountTitle
            icon={
              <TimelineIconCircleWrapper>
                <StyledTimelineCheckmarkIcon src={CheckmarkIcon} />
              </TimelineIconCircleWrapper>
            }
          >
            <SuccessTextBold>
              <Trans>Refunded to</Trans>
            </SuccessTextBold>
            <RefundRecipientWrapper>
              <NetworkLogo chainId={sourceChainId} size={16} />
              <b>
                <RefundLink
                  href={getExplorerLink(sourceChainId, account, ExplorerDataType.ADDRESS)}
                  target="_blank"
                  underline
                >
                  {shortenAddress(account)} ↗
                </RefundLink>
              </b>
            </RefundRecipientWrapper>
          </ReceiveAmountTitle>
        }
      >
        <b>
          <TokenAmountDisplay displaySymbol currencyAmount={bridgeSendCurrencyAmount} />
        </b>
      </ConfirmDetailsItem>
    </>
  )
}
