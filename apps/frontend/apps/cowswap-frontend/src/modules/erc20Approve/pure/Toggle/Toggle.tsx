import { ReactNode } from 'react'

import EDIT from '@cowprotocol/assets/cow-swap/edit.svg'
import { Currency, CurrencyAmount } from '@cowprotocol/currency'
import { TokenAmount, TokenSymbol } from '@cowprotocol/ui'

import { Trans, useLingui } from '@lingui/react/macro'
import { MobileSwapReveal } from 'ophis/mobile/MobileSwapReveal.pure'
import SVG from 'react-inlinesvg'
import { useTheme } from 'styled-components/macro'

import { Option } from './Option'
import * as styledEl from './styled'

export function Toggle({
  isPartialApproveSelected,
  selectPartialApprove,
  amountToApprove,
  changeApproveAmount,
}: {
  isPartialApproveSelected: boolean
  selectPartialApprove: (isPartialApproveEnabled: boolean) => void
  amountToApprove: CurrencyAmount<Currency>
  changeApproveAmount?: () => void
}): ReactNode {
  const { t } = useLingui()

  const { isOphisMobileSwap } = useTheme()

  const options = (
    <styledEl.ToggleWrapper>
      <Option
        isActive={isPartialApproveSelected}
        onClick={() => selectPartialApprove(true)}
        title={t`Partial approval`}
      >
        <styledEl.PartialAmountWrapper
          onClick={() => {
            if (isPartialApproveSelected && changeApproveAmount) {
              changeApproveAmount()
            }
          }}
        >
          <TokenAmount amount={amountToApprove} /> <TokenSymbol token={amountToApprove.currency} />{' '}
          <styledEl.EditIcon>
            <SVG src={EDIT} description="Edit" />
          </styledEl.EditIcon>
        </styledEl.PartialAmountWrapper>
      </Option>
      <Option isActive={!isPartialApproveSelected} onClick={() => selectPartialApprove(false)} title={t`Full approval`}>
        <Trans>Unlimited one-time</Trans>
      </Option>
    </styledEl.ToggleWrapper>
  )

  if (!isOphisMobileSwap) return options

  return (
    <>
      <MobileSwapReveal>
        <styledEl.SpendingLimit aria-label={t`Spending limit`}>
          <h3>
            <Trans>Spending limit</Trans>
          </h3>
          <styledEl.SpendingAmount data-testid="spending-limit-amount">
            {isPartialApproveSelected ? (
              <>
                {amountToApprove.toExact()} <TokenSymbol token={amountToApprove.currency} />
              </>
            ) : (
              <Trans>Unlimited</Trans>
            )}
          </styledEl.SpendingAmount>
          <p>
            {isPartialApproveSelected ? (
              <Trans>Only this amount will be approved.</Trans>
            ) : (
              <Trans>This approval allows unlimited spending.</Trans>
            )}
          </p>
          {isPartialApproveSelected && changeApproveAmount && (
            <button type="button" onClick={changeApproveAmount}>
              <Trans>Edit limit</Trans>
            </button>
          )}
        </styledEl.SpendingLimit>
      </MobileSwapReveal>
      <styledEl.ApprovalOptions>
        <summary>
          <Trans>Approval options</Trans>
        </summary>
        {options}
      </styledEl.ApprovalOptions>
    </>
  )
}
