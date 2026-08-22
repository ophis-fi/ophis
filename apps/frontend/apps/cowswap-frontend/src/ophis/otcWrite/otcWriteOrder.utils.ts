import { getAddressKey } from '@cowprotocol/cow-sdk'

import { getOtcTokenMeta } from 'ophis/otc'
import { isAddressEqual } from 'viem'

import type { OtcOrder } from 'ophis/otc'

type OtcReviewKeyPart = string | number | bigint | boolean
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

function normalizeReviewKeyPart(part: OtcReviewKeyPart): string {
  const value = String(part)
  return ADDRESS_PATTERN.test(value) ? getAddressKey(value) : value
}

/** A checked review is valid only for one wallet account and one exact action payload. */
export function getOtcActionReviewKey(account: string | undefined, parts: readonly OtcReviewKeyPart[]): string {
  return [account ? getAddressKey(account) : 'disconnected', ...parts.map(normalizeReviewKeyPart)].join(':')
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

export function shouldMountOtcOrderAction(writeEnabled: boolean, order: OtcOrder | null): boolean {
  if (!writeEnabled || !order || !isReviewedOtcOrder(order)) return false
  if (!order.active) return true
  // Active actions are enabled only after OtcActionControl verifies the local
  // fork, then the wallet sink re-reads and simulates the exact fork state.
  // Canonical-mainnet index freshness is not evidence about a fork timeline.
  return true
}
