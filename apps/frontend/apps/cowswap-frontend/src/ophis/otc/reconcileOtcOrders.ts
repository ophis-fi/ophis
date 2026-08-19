import { isAddressEqual } from 'viem'

import type {
  OtcIndexedOrder,
  OtcOrder,
  OtcOrderField,
  OtcOrderMismatch,
  OtcReconciliationReport,
  OtcSnapshot,
} from './otc.types'

function ascending(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function collectMismatches(indexed: OtcIndexedOrder, onchain: OtcOrder): OtcOrderMismatch[] {
  const comparisons: Array<[OtcOrderField, boolean, string, string]> = [
    ['maker', isAddressEqual(indexed.maker, onchain.maker), indexed.maker, onchain.maker],
    ['active', indexed.active === onchain.active, String(indexed.active), String(onchain.active)],
    ['tokenA', isAddressEqual(indexed.tokenA, onchain.tokenA), indexed.tokenA, onchain.tokenA],
    ['amountA', indexed.amountA === onchain.amountA, indexed.amountA.toString(), onchain.amountA.toString()],
    ['tokenB', isAddressEqual(indexed.tokenB, onchain.tokenB), indexed.tokenB, onchain.tokenB],
    ['amountB', indexed.amountB === onchain.amountB, indexed.amountB.toString(), onchain.amountB.toString()],
  ]

  return comparisons
    .filter(([, equal]) => !equal)
    .map(([field, , indexedValue, onchainValue]) => ({
      orderId: indexed.orderId,
      field,
      indexed: indexedValue,
      onchain: onchainValue,
    }))
}

/**
 * Direct on-chain reconciliation: contract state is the only settlement
 * authority. An indexed order is verified ONLY when every term matches the
 * snapshot exactly. Ids outside the snapshot's enumerated window are
 * unknown — a truncated enumeration must never label anything verified that
 * the chain read did not cover.
 */
export function reconcileOtcOrders(indexed: OtcIndexedOrder[], snapshot: OtcSnapshot): OtcReconciliationReport {
  const onchainById = new Map(snapshot.orders.map((order) => [order.orderId.toString(), order]))
  const windowFloor = snapshot.orders.reduce(
    (min, order) => (order.orderId < min ? order.orderId : min),
    snapshot.nextOrderId,
  )

  const verifiedIds: bigint[] = []
  const mismatches: OtcOrderMismatch[] = []
  const missingOnchain: bigint[] = []
  const unknownIds: bigint[] = []
  const indexedIds = new Set<string>()

  for (const row of indexed) {
    indexedIds.add(row.orderId.toString())

    if (row.orderId < windowFloor || row.orderId >= snapshot.nextOrderId) {
      unknownIds.push(row.orderId)
      continue
    }

    const onchain = onchainById.get(row.orderId.toString())
    if (!onchain) {
      missingOnchain.push(row.orderId)
      continue
    }

    const rowMismatches = collectMismatches(row, onchain)
    if (rowMismatches.length === 0) {
      verifiedIds.push(row.orderId)
    } else {
      mismatches.push(...rowMismatches)
    }
  }

  const notIndexed = snapshot.orders
    .map((order) => order.orderId)
    .filter((orderId) => !indexedIds.has(orderId.toString()))

  return {
    verifiedIds: verifiedIds.sort(ascending),
    mismatches,
    missingOnchain: missingOnchain.sort(ascending),
    notIndexed: notIndexed.sort(ascending),
    unknownIds: unknownIds.sort(ascending),
  }
}
