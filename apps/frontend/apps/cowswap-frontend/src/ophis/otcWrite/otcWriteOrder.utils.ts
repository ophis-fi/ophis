import { getOtcTokenMeta } from 'ophis/otc'
import { isAddressEqual } from 'viem'

import type { OtcOrder } from 'ophis/otc'

type OtcReviewKeyPart = string | number | bigint | boolean

/** A checked review is valid only for one wallet account and one exact action payload. */
export function getOtcActionReviewKey(account: string | undefined, parts: readonly OtcReviewKeyPart[]): string {
  return [account?.toLowerCase() ?? 'disconnected', ...parts.map((part) => String(part).toLowerCase())].join(':')
}

export function isReviewedOtcOrder(order: OtcOrder): boolean {
  return (
    order.amountA > 0n &&
    order.amountB > 0n &&
    !isAddressEqual(order.tokenA, order.tokenB) &&
    !!getOtcTokenMeta(order.tokenA) &&
    !!getOtcTokenMeta(order.tokenB)
  )
}

export function shouldMountOtcOrderAction(
  writeEnabled: boolean,
  freshness: 'fresh' | 'stale' | 'unknown',
  order: OtcOrder | null,
  indexedAgrees: boolean,
  account: string | undefined,
): boolean {
  if (!writeEnabled || !order || !isReviewedOtcOrder(order)) return false
  if (!order.active) return !!account && !isAddressEqual(account, order.maker)
  return freshness === 'fresh' && indexedAgrees
}
