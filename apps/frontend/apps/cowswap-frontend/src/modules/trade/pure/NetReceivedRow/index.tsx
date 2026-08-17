import { ReactNode } from 'react'

import { Currency, CurrencyAmount, Token } from '@cowprotocol/currency'
import { Command } from '@cowprotocol/types'
import { FiatAmount, HoverTooltip, RowBetween, RowFixed, TokenAmount, UI } from '@cowprotocol/ui'

import { Trans } from '@lingui/react/macro'
import { Info } from 'react-feather'
import styled from 'styled-components/macro'
import { Nullish } from 'types'

import { NetReceivedKind } from '../../hooks/useNetReceivedUsd'

const Wrapper = styled(RowBetween)`
  flex-flow: row nowrap;
  gap: 16px;
  padding: 0 10px;
  font-size: 13px;
  color: inherit;
`

const Label = styled.span`
  display: flex;
  align-items: center;
  gap: 4px;
  font-weight: 400;
  opacity: 0.85;
`

const Value = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-weight: 600;
  text-align: right;

  .fiat-amount {
    opacity: 1;
  }
`

const GasSuffix = styled.span`
  font-weight: 400;
  opacity: 0.7;
`

const StyledInfoIcon = styled(Info)`
  color: inherit;
  opacity: 0.6;
  line-height: 0;
  vertical-align: middle;
  transition: opacity var(${UI.ANIMATION_DURATION}) ease-in-out;

  &:hover {
    opacity: 1;
  }
`

const TooltipContent = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
`

const TooltipRow = styled.div`
  display: flex;
  justify-content: space-between;
  gap: 16px;
`

export interface NetReceivedRowContentProps {
  netAmount: CurrencyAmount<Currency>
  netUsd: Nullish<CurrencyAmount<Token>>
  grossUsd: Nullish<CurrencyAmount<Token>>
  totalCostsUsd: Nullish<CurrencyAmount<Token>>
  userPaysGasOnTop: boolean
  kind: NetReceivedKind
  /** Fee line for the tooltip: label from the volume-fee context plus the applied bps. */
  feeLabel?: string
  feeBps?: number
  /** Widget param: suppress USD values entirely (token amount shown instead). */
  hideUsdValues?: boolean
  /** Fired once each time the breakdown tooltip opens (net_received_tooltip_open). */
  onTooltipOpen?: Command
}

/**
 * Always-visible net-of-costs headline (ux-quoting decision 59): what the user
 * actually receives (sell) or pays (buy) after network costs and the Ophis
 * fee, USD-first with the token amount as fallback when no USD price is known
 * or the widget hides USD values. Gas is never estimated: when the wallet pays
 * gas on top, the row says so with a "+ gas" suffix.
 */
export function NetReceivedRowContent(props: NetReceivedRowContentProps): ReactNode {
  const { netAmount, netUsd, grossUsd, totalCostsUsd, userPaysGasOnTop, kind, feeLabel, feeBps, hideUsdValues } = props

  const showUsd = !hideUsdValues && !!netUsd

  const tooltipContent = (
    <TooltipContent>
      <div>
        {kind === 'receive' ? (
          <Trans>Network costs and the Ophis fee are already included in this amount.</Trans>
        ) : (
          <Trans>Network costs and the Ophis fee are already included in this amount you pay.</Trans>
        )}
      </div>
      {!hideUsdValues && grossUsd && (
        <TooltipRow>
          <span>
            <Trans>Before costs</Trans>
          </span>
          <FiatAmount amount={grossUsd} />
        </TooltipRow>
      )}
      {!hideUsdValues && totalCostsUsd && (
        <TooltipRow>
          <span>
            <Trans>Total costs</Trans>
          </span>
          <FiatAmount amount={totalCostsUsd} />
        </TooltipRow>
      )}
      {!!feeBps && feeBps > 0 && (
        <TooltipRow>
          <span>{feeLabel || <Trans>Fee</Trans>}</span>
          <span>{feeBps} bps</span>
        </TooltipRow>
      )}
      {userPaysGasOnTop && (
        <div>
          <Trans>Gas for this transaction is paid by your wallet on top of the amounts shown.</Trans>
        </div>
      )}
      <div>
        <Trans>If a solver settles your order at a better price, the surplus is returned to you on top.</Trans>
      </div>
    </TooltipContent>
  )

  return (
    <Wrapper data-testid="net-received-row">
      <RowFixed>
        <Label>
          {kind === 'receive' ? <Trans>You receive (net)</Trans> : <Trans>You pay (net)</Trans>}
          <HoverTooltip wrapInContainer content={tooltipContent} onOpen={props.onTooltipOpen}>
            <StyledInfoIcon size={16} />
          </HoverTooltip>
        </Label>
      </RowFixed>
      <Value>
        {showUsd ? <FiatAmount amount={netUsd} /> : <TokenAmount amount={netAmount} tokenSymbol={netAmount.currency} />}
        {userPaysGasOnTop && (
          <GasSuffix>
            <Trans>+ gas</Trans>
          </GasSuffix>
        )}
      </Value>
    </Wrapper>
  )
}
