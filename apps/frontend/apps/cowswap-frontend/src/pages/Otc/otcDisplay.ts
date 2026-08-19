import {
  computeOtcRate,
  getOtcTokenMeta,
  isOtcOrderDisplayReviewed,
  type OtcRate,
  OtcDataState,
  OtcOrder,
} from 'ophis/otc'

export type OtcResolution = 'active' | 'filled' | 'cancelled' | 'inactive'

export interface OtcDisplayRow {
  order: OtcOrder
  /** Both legs are Ophis-curated tokens. */
  reviewed: boolean
  /** Indexed terms reconciled exactly against on-chain state. */
  verified: boolean
  /** Indexed terms DISAGREE with on-chain state. */
  mismatch: boolean
  createdAt: number | null
  resolution: OtcResolution
  rate: OtcRate | null
}

function resolveResolution(order: OtcOrder, state: OtcDataState): OtcResolution {
  if (order.active) return 'active'
  const indexed = state.enrichment?.byOrderId.get(order.orderId.toString())
  if (indexed?.filledAt != null) return 'filled'
  if (indexed?.cancelledAt != null) return 'cancelled'
  return 'inactive'
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
      resolution: resolveResolution(order, state),
      rate: computeRowRate(order),
    }
  })
}

export function filterBrowseRows(rows: OtcDisplayRow[]): OtcDisplayRow[] {
  return rows.filter((row) => row.resolution === 'active')
}

export function filterMakerRows(rows: OtcDisplayRow[], account: string): OtcDisplayRow[] {
  const needle = account.toLowerCase()
  return rows.filter((row) => row.order.maker.toLowerCase() === needle)
}

export function formatOtcAge(nowMs: number, createdAt: number | null): string {
  if (createdAt === null) return '—'
  const seconds = Math.max(0, Math.floor(nowMs / 1_000) - createdAt)
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
