/* eslint-disable @typescript-eslint/no-restricted-imports */ // TODO: Don't use 'modules' import
import { ReactNode } from 'react'

import { TokenAmount } from '@cowprotocol/ui'

import { useLingui } from '@lingui/react/macro'

import { BalanceAndSubsidy } from 'legacy/hooks/useCowBalanceAndSubsidy'

import { getOrderTypeReceiveAmounts } from 'modules/trade'
import { useEstimatedBridgeBuyAmount } from 'modules/trade'
import { ReceiveAmountInfo } from 'modules/trade'

import { safeToExact } from 'common/utils/safeCurrencyAmount'

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
  // Defensive: a CurrencyAmount instance hydrated from a stale persisted
  // atom can have `.currency = undefined`. `safeToExact` swallows the
  // throw inside `.toExact()` (which internally reads `.currency.decimals`);
  // the symbol read is already guarded. Title is tooltip-only — degrade
  // gracefully rather than crashing the swap form.
  const title = `${safeToExact(minToReceiveAmount)} ${minToReceiveAmount?.currency?.symbol ?? ''}`.trim()

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
