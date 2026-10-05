import { ReactNode } from 'react'

import { TradeWidgetParams } from './types'

/** Keep the form layout and the selector container's sizing decision aligned. */
export function isAssetSwapLayout(
  params: Pick<TradeWidgetParams, 'isMarketOrderWidget' | 'externalFunding'>,
  middleContent: ReactNode,
): boolean {
  return Boolean(params.isMarketOrderWidget && !middleContent && !params.externalFunding)
}
