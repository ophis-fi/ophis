import { getAddress, type Address, type Hex } from 'viem'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'

import type { OtcIndexedOrder } from './otc.types'

const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i
const PAGE_SIZE = 1_000

const ORDERS_QUERY = `{
  _meta { block { number } }
  orders(first: ${PAGE_SIZE}, orderBy: orderId, orderDirection: desc) {
    orderId maker active taker
    createdAt createdTx filledAt filledTx cancelledAt cancelledTx
    amountA amountB tokenA { id } tokenB { id }
  }
}`

export interface OtcIndexedOrdersResult {
  orders: OtcIndexedOrder[]
  indexedBlock: bigint
  /** Malformed rows are dropped, never rendered; the count keeps the drop visible. */
  droppedRows: number
}

function requestFailed(): Error {
  return new Error('Ophis OTC index request failed')
}

function responseRejected(): Error {
  return new Error('Ophis OTC index response rejected')
}

function parseAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null
  try {
    return getAddress(value)
  } catch {
    return null
  }
}

function parseTxHash(value: unknown): Hex | null {
  return typeof value === 'string' && TX_HASH_PATTERN.test(value) ? (value.toLowerCase() as Hex) : null
}

function parseAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  return BigInt(value)
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseIndexedOrder(value: unknown): OtcIndexedOrder | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const tokenA = typeof row.tokenA === 'object' && row.tokenA !== null ? (row.tokenA as Record<string, unknown>) : null
  const tokenB = typeof row.tokenB === 'object' && row.tokenB !== null ? (row.tokenB as Record<string, unknown>) : null

  const orderId = parseAmount(row.orderId)
  const maker = parseAddress(row.maker)
  const tokenAAddress = parseAddress(tokenA?.id)
  const tokenBAddress = parseAddress(tokenB?.id)
  const amountA = parseAmount(row.amountA)
  const amountB = parseAmount(row.amountB)
  const createdAt = parseTimestamp(row.createdAt)
  const createdTx = parseTxHash(row.createdTx)
  if (
    orderId === null ||
    maker === null ||
    typeof row.active !== 'boolean' ||
    tokenAAddress === null ||
    tokenBAddress === null ||
    amountA === null ||
    amountB === null ||
    createdAt === null ||
    createdTx === null
  ) {
    return null
  }

  // Resolution fields are optional but must be well-formed when present.
  const taker = row.taker == null ? null : parseAddress(row.taker)
  const filledAt = row.filledAt == null ? null : parseTimestamp(row.filledAt)
  const filledTx = row.filledTx == null ? null : parseTxHash(row.filledTx)
  const cancelledAt = row.cancelledAt == null ? null : parseTimestamp(row.cancelledAt)
  const cancelledTx = row.cancelledTx == null ? null : parseTxHash(row.cancelledTx)
  if (row.taker != null && taker === null) return null
  if (row.filledAt != null && filledAt === null) return null
  if (row.filledTx != null && filledTx === null) return null
  if (row.cancelledAt != null && cancelledAt === null) return null
  if (row.cancelledTx != null && cancelledTx === null) return null

  return {
    orderId,
    maker,
    active: row.active,
    tokenA: tokenAAddress,
    amountA,
    tokenB: tokenBAddress,
    amountB,
    createdAt,
    createdTx,
    taker,
    filledAt,
    filledTx,
    cancelledAt,
    cancelledTx,
  }
}

function parseIndexedBlock(data: Record<string, unknown>): bigint {
  const meta = data._meta as Record<string, unknown> | undefined
  const block = meta?.block as Record<string, unknown> | undefined
  const blockNumber = block?.number
  if (typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber <= 0) {
    throw responseRejected()
  }
  return BigInt(blockNumber)
}

/**
 * Discovery/enrichment data from the upstream-operated public subgraph.
 * NEVER settlement authority: rows only decorate on-chain state and every
 * displayed term must reconcile against the contract before being labeled
 * verified. Malformed rows are dropped (and counted); a malformed envelope
 * throws so the UI can show the degraded state.
 */
export async function fetchOtcIndexedOrders(fetchImpl: typeof fetch = fetch): Promise<OtcIndexedOrdersResult> {
  const manifest = OPHIS_ETHEREUM_OTC_MANIFEST
  const response = await fetchImpl(manifest.subgraphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: ORDERS_QUERY }),
    signal: AbortSignal.timeout(manifest.subgraphTimeoutMs),
  })
  if (!response.ok) throw requestFailed()

  const body = (await response.json()) as Record<string, unknown>
  if (body.errors !== undefined || typeof body.data !== 'object' || body.data === null) throw requestFailed()

  const data = body.data as Record<string, unknown>
  const indexedBlock = parseIndexedBlock(data)
  if (!Array.isArray(data.orders)) throw responseRejected()

  const orders: OtcIndexedOrder[] = []
  let droppedRows = 0
  for (const row of data.orders) {
    const parsed = parseIndexedOrder(row)
    if (parsed) {
      orders.push(parsed)
    } else {
      droppedRows += 1
    }
  }

  return { orders, indexedBlock, droppedRows }
}

export function computeIndexLag(indexedBlock: bigint, chainBlock: bigint): bigint {
  return chainBlock > indexedBlock ? chainBlock - indexedBlock : 0n
}
