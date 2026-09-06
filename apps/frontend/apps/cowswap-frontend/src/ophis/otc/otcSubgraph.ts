import { getAddress, maxUint256, type Address, type Hex } from 'viem'

import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'

import type { OtcIndexedOrder, OtcManifest } from './otc.types'

const TX_HASH_PATTERN = /^0x[0-9a-f]{64}$/i
const PAGE_SIZE = 1_000
const MAX_UINT256_DECIMAL_LENGTH = maxUint256.toString().length

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
  if (typeof value !== 'string' || value.length > MAX_UINT256_DECIMAL_LENGTH || !/^\d+$/.test(value)) return null
  const amount = BigInt(value)
  return amount <= maxUint256 ? amount : null
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function nestedId(value: unknown): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>).id : undefined
}

/** null-permitting: absent is valid; present-but-malformed is not. */
function parseOptional<T>(raw: unknown, parser: (value: unknown) => T | null): { ok: boolean; value: T | null } {
  if (raw == null) return { ok: true, value: null }
  const parsed = parser(raw)
  return { ok: parsed !== null, value: parsed }
}

function parseIndexedOrder(value: unknown): OtcIndexedOrder | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.active !== 'boolean') return null

  const required = {
    orderId: parseAmount(row.orderId),
    maker: parseAddress(row.maker),
    tokenA: parseAddress(nestedId(row.tokenA)),
    amountA: parseAmount(row.amountA),
    tokenB: parseAddress(nestedId(row.tokenB)),
    amountB: parseAmount(row.amountB),
    createdAt: parseTimestamp(row.createdAt),
    createdTx: parseTxHash(row.createdTx),
  }
  if (Object.values(required).some((field) => field === null)) return null

  // Resolution fields are optional but must be well-formed when present.
  const optional = {
    taker: parseOptional(row.taker, parseAddress),
    filledAt: parseOptional(row.filledAt, parseTimestamp),
    filledTx: parseOptional(row.filledTx, parseTxHash),
    cancelledAt: parseOptional(row.cancelledAt, parseTimestamp),
    cancelledTx: parseOptional(row.cancelledTx, parseTxHash),
  }
  if (Object.values(optional).some((field) => !field.ok)) return null

  return {
    orderId: required.orderId as bigint,
    maker: required.maker as Address,
    active: row.active,
    tokenA: required.tokenA as Address,
    amountA: required.amountA as bigint,
    tokenB: required.tokenB as Address,
    amountB: required.amountB as bigint,
    createdAt: required.createdAt as number,
    createdTx: required.createdTx as Hex,
    taker: optional.taker.value,
    filledAt: optional.filledAt.value,
    filledTx: optional.filledTx.value,
    cancelledAt: optional.cancelledAt.value,
    cancelledTx: optional.cancelledTx.value,
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
export async function fetchOtcIndexedOrders(
  fetchImpl: typeof fetch = fetch,
  manifest: OtcManifest = OPHIS_ETHEREUM_OTC_MANIFEST,
): Promise<OtcIndexedOrdersResult> {
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
  return { ...parseIndexedPage(data.orders), indexedBlock }
}

function parseIndexedPage(rows: unknown): Pick<OtcIndexedOrdersResult, 'orders' | 'droppedRows'> {
  if (!Array.isArray(rows) || rows.length > PAGE_SIZE) throw responseRejected()

  const orders: OtcIndexedOrder[] = []
  const orderIds = new Set<bigint>()
  let droppedRows = 0
  for (const row of rows) {
    const parsed = parseIndexedOrder(row)
    if (parsed) {
      if (orderIds.has(parsed.orderId)) throw responseRejected()
      orderIds.add(parsed.orderId)
      orders.push(parsed)
    } else {
      droppedRows += 1
    }
  }

  return { orders, droppedRows }
}

export function computeIndexLag(indexedBlock: bigint, chainBlock: bigint): bigint {
  return chainBlock > indexedBlock ? chainBlock - indexedBlock : 0n
}
