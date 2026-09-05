import { getAddressKey } from '@cowprotocol/cow-sdk'

import {
  computeOtcRate,
  getOtcTokenMeta,
  isOtcOrderDisplayReviewed,
  type OtcRate,
  OtcDataState,
  OtcOrder,
} from 'ophis/otc'

export type OtcResolution = 'active' | 'inactive'

export type OtcIndexClaim = 'filled' | 'cancelled' | null

export interface OtcDisplayRow {
  order: OtcOrder
  /** Both legs are Ophis-curated tokens. */
  reviewed: boolean
  /** Indexed terms reconciled exactly against on-chain state. */
  verified: boolean
  /** Indexed terms DISAGREE with on-chain state. */
  mismatch: boolean
  createdAt: number | null
  /** Chain-authoritative: the contract's active flag, nothing else. */
  resolution: OtcResolution
  /**
   * Index-derived lifecycle claim (filled vs cancelled). NOT verified
   * on-chain — reconciliation covers terms and the active flag only — so the
   * UI must always label it as an index claim, never as authoritative state.
   */
  indexClaim: OtcIndexClaim
  rate: OtcRate | null
}

function resolveIndexClaim(order: OtcOrder, state: OtcDataState): OtcIndexClaim {
  if (order.active) return null
  const indexed = state.enrichment?.byOrderId.get(order.orderId.toString())
  if (indexed?.filledAt != null) return 'filled'
  if (indexed?.cancelledAt != null) return 'cancelled'
  return null
}

function computeRowRate(order: OtcOrder): OtcRate | null {
  const metaA = getOtcTokenMeta(order.tokenA)
  const metaB = getOtcTokenMeta(order.tokenB)
  if (!metaA || !metaB) return null
  return computeOtcRate(order.amountA, metaA.decimals, order.amountB, metaB.decimals)
}

/** Snapshot orders (newest-first, on-chain authority) decorated for display. */
export function buildOtcDisplayRows(state: OtcDataState): OtcDisplayRow[] {
  if (!state.snapshot) return []

  const verifiedIds = new Set((state.reconciliation?.verifiedIds ?? []).map((orderId) => orderId.toString()))
  const mismatchedIds = new Set((state.reconciliation?.mismatches ?? []).map((entry) => entry.orderId.toString()))

  return state.snapshot.orders.map((order) => {
    const key = order.orderId.toString()
    return {
      order,
      reviewed: isOtcOrderDisplayReviewed(order),
      verified: verifiedIds.has(key),
      mismatch: mismatchedIds.has(key),
      createdAt: state.enrichment?.byOrderId.get(key)?.createdAt ?? null,
      resolution: order.active ? 'active' : 'inactive',
      indexClaim: resolveIndexClaim(order, state),
      rate: computeRowRate(order),
    }
  })
}

/**
 * Browse is the official liquidity surface: active orders whose BOTH legs are
 * Ophis-curated (spec: "Browse: active allowlisted orders" — discovery-level
 * policy enforcement). Unreviewed-token orders stay reachable read-only via
 * My orders and direct detail links, never as browseable liquidity.
 */
export function filterBrowseRows(rows: OtcDisplayRow[]): OtcDisplayRow[] {
  return rows.filter((row) => row.resolution === 'active' && row.reviewed)
}

export function filterMakerRows(rows: OtcDisplayRow[], account: string): OtcDisplayRow[] {
  const needle = getAddressKey(account)
  return rows.filter((row) => getAddressKey(row.order.maker) === needle)
}

export interface OtcAgeValue {
  value: number
  unit: 'minutes' | 'hours' | 'days'
}

export function getOtcAge(nowMs: number, createdAt: number | null): OtcAgeValue | null {
  if (createdAt === null) return null
  const seconds = Math.max(0, Math.floor(nowMs / 1_000) - createdAt)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { value: minutes, unit: 'minutes' }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return { value: hours, unit: 'hours' }
  return { value: Math.floor(hours / 24), unit: 'days' }
}
