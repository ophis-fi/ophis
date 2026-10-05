import { TradeWidgetParams, TradeWidgetSlots } from './types'

/** Keep the form layout and the selector container's sizing decision aligned. */
export function isAssetSwapLayout(
  params: Pick<TradeWidgetParams, 'isMarketOrderWidget' | 'externalFunding'>,
  slots: Pick<TradeWidgetSlots, 'currencyFields' | 'middleContent'>,
): boolean {
  return Boolean(slots.currencyFields && params.isMarketOrderWidget && !slots.middleContent)
}
