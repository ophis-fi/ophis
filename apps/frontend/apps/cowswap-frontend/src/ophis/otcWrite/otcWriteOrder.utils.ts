import { getOtcTokenMeta } from 'ophis/otc'

import type { OtcOrder } from 'ophis/otc'

export function isReviewedOtcOrder(order: OtcOrder): boolean {
  return !!getOtcTokenMeta(order.tokenA) && !!getOtcTokenMeta(order.tokenB)
}
