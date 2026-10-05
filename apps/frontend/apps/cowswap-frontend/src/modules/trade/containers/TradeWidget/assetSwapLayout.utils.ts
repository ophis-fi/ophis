import { ReactNode } from 'react'

import { TradeWidgetParams } from './types'

/** Keep the form layout and the selector container's sizing decision aligned. */
export function isAssetSwapLayout(
  params: Pick<TradeWidgetParams, 'isMarketOrderWidget' | 'enableAssetSwapLayout' | 'externalFunding'>,
  middleContent: ReactNode,
): boolean {
  return Boolean(
    params.enableAssetSwapLayout && params.isMarketOrderWidget && !middleContent && !params.externalFunding,
  )
}
