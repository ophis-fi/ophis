import { ReactNode } from 'react'

import { PriceImpact } from 'legacy/hooks/usePriceImpact'

import { TokenPickerOptions } from 'modules/tokensList'

import { CurrencyInputPanelProps } from 'common/pure/CurrencyInputPanel'
import { CurrencyInfo } from 'common/pure/CurrencyInputPanel/types'

export interface TradeWidgetActions {
  onCurrencySelection: CurrencyInputPanelProps['onCurrencySelection']
  onUserInput: CurrencyInputPanelProps['onUserInput']
  onChangeRecipient: (recipient: string | null) => void

  /** False means the reverse route was rejected; legacy handlers return void. */
  onSwitchTokens(): boolean | void
}

export interface TradeWidgetParams {
  externalFunding?: boolean
  inputTokenOptions?: TokenPickerOptions
  outputTokenOptions?: TokenPickerOptions
  recipient?: string | null
  compactView: boolean
  showRecipient: boolean
  isTradePriceUpdating: boolean
  priceImpact: PriceImpact
  disableTradeNotifications?: boolean
  disableQuotePolling?: boolean
  disableNativeSelling?: boolean
  disablePriceImpact?: boolean
  disableSuggestedSlippageApi?: boolean
  hideTradeWarnings?: boolean
  enableSmartSlippage?: boolean
  isMarketOrderWidget?: boolean
  enableAssetSwapLayout?: boolean
  displayTokenName?: boolean
  displayChainName?: boolean
  inputsDisabled?: boolean
  disableTokenSwitch?: boolean
  isPriceStatic?: boolean
  allowSwapSameToken?: boolean
  customSelectTokenButton?: ReactNode
}

export interface TradeWidgetSlots {
  headerContent?: ReactNode
  settingsWidget: ReactNode
  lockScreen?: ReactNode
  topContent?: ReactNode
  middleContent?: ReactNode
  bottomContent?(warnings: ReactNode | null): ReactNode
  outerContent?: ReactNode
  updaters?: ReactNode
  selectTokenWidget?: ReactNode
}

export interface TradeWidgetProps {
  id?: string
  slots: TradeWidgetSlots
  inputCurrencyInfo: CurrencyInfo
  outputCurrencyInfo: CurrencyInfo
  actions: TradeWidgetActions
  params: TradeWidgetParams
  disableOutput?: boolean
  confirmModal?: ReactNode
  genericModal?: ReactNode
}
