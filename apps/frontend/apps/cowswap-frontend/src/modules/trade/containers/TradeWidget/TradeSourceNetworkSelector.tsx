import { ReactNode } from 'react'

import { isSupportedChainId } from '@cowprotocol/common-utils'
import { TargetChainId } from '@cowprotocol/cow-sdk'

import { Field } from 'legacy/state/types'

// The application barrel imports the router, which depends back on the trade widget.
import { NetworkSelector } from 'modules/application/containers/NetworkSelector/NetworkSelector.container'
import { useOpenTokenSelectWidget } from 'modules/tokensList'

import { TradeWidgetProps } from './types'

interface TradeSourceNetworkSelectorProps {
  widget: TradeWidgetProps
  openTokenSelectWidget: ReturnType<typeof useOpenTokenSelectWidget>
}

export function TradeSourceNetworkSelector({
  widget: { inputCurrencyInfo, outputCurrencyInfo, actions, params },
  openTokenSelectWidget,
}: TradeSourceNetworkSelectorProps): ReactNode {
  return (
    <NetworkSelector
      selectedChainId={inputCurrencyInfo.currency?.chainId as TargetChainId | undefined}
      additionalChainIds={params.inputTokenOptions?.chains.map(({ id }) => id as TargetChainId)}
      disabled={params.inputsDisabled}
      onSelectChain={(chainId) => {
        if (!params.externalFunding && isSupportedChainId(chainId)) return false
        openTokenSelectWidget(
          inputCurrencyInfo.currency,
          Field.INPUT,
          outputCurrencyInfo.currency ?? undefined,
          (currency) => actions.onCurrencySelection(Field.INPUT, currency),
          chainId,
        )
        return true
      }}
    />
  )
}
