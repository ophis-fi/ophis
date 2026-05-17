/* eslint-disable @typescript-eslint/no-restricted-imports */ // TODO: Don't use 'modules' import
import { ReactNode } from 'react'

import { TokenAmount } from '@cowprotocol/ui'

import { useLingui } from '@lingui/react/macro'

import { BalanceAndSubsidy } from 'legacy/hooks/useCowBalanceAndSubsidy'

import { getOrderTypeReceiveAmounts } from 'modules/trade'
import { useEstimatedBridgeBuyAmount } from 'modules/trade'
import { ReceiveAmountInfo } from 'modules/trade'

import * as styledEl from './styled'

import { BridgeReceiveAmountInfo } from '../BridgeReceiveAmountInfo'
import { ReceiveAmountInfoTooltip } from '../ReceiveAmountInfo'

export interface ReceiveAmountProps {
  receiveAmountInfo: ReceiveAmountInfo
  subsidyAndBalance: BalanceAndSubsidy
  allowsOffchainSigning: boolean
  loading?: boolean
}

export function ReceiveAmount(props: ReceiveAmountProps): ReactNode {
  const { isSell } = props.receiveAmountInfo
  const { t } = useLingui()
  const bridgeEstimatedAmounts = useEstimatedBridgeBuyAmount()

  const { amountAfterFees } = getOrderTypeReceiveAmounts(props.receiveAmountInfo)

  const minToReceiveAmount = bridgeEstimatedAmounts?.minToReceiveAmount ?? amountAfterFees
  // Defensive: 2026-05-17 production incident — a CurrencyAmount instance
  // hydrated from a stale persisted atom can have `.currency = undefined`,
  // crashing the entire React tree with "Cannot read properties of undefined
  // (reading 'symbol')". The title is purely a tooltip hover string — degrade
  // gracefully rather than crashing the swap form.
  const title = `${minToReceiveAmount?.toExact() ?? ''} ${minToReceiveAmount?.currency?.symbol ?? ''}`.trim()

  return (
    <styledEl.ReceiveAmountBox>
      <div>
        <span>{!isSell ? t`From (incl. fees)` : t`Receive (incl. fees)`}</span>
        <styledEl.QuestionHelperWrapped
          text={
            bridgeEstimatedAmounts ? (
              <BridgeReceiveAmountInfo bridgeEstimatedAmounts={bridgeEstimatedAmounts} />
            ) : (
              <ReceiveAmountInfoTooltip {...props} />
            )
          }
        />
      </div>
      <div>
        <styledEl.ReceiveAmountValue title={title}>
          <TokenAmount amount={minToReceiveAmount} defaultValue="0" />
        </styledEl.ReceiveAmountValue>
      </div>
    </styledEl.ReceiveAmountBox>
  )
}
