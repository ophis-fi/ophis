import { getAddressKey } from '@cowprotocol/cow-sdk'

import type { OtcIndexedOrder, OtcOrder } from 'ophis/otc'

export function indexedOtcOrderDisagrees(indexed: OtcIndexedOrder, order: OtcOrder): boolean {
  return (
    getAddressKey(indexed.maker) !== getAddressKey(order.maker) ||
    indexed.active !== order.active ||
    getAddressKey(indexed.tokenA) !== getAddressKey(order.tokenA) ||
    indexed.amountA !== order.amountA ||
    getAddressKey(indexed.tokenB) !== getAddressKey(order.tokenB) ||
    indexed.amountB !== order.amountB
  )
}
