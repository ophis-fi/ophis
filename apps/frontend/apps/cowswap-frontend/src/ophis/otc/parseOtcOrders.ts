import { getAddress, isAddressEqual, maxUint256, zeroAddress, type Address } from 'viem'

import type { OtcOrder } from './otc.types'

interface RawOrderRow {
  maker: unknown
  active: unknown
  tokenA: unknown
  amountA: unknown
  tokenB: unknown
  amountB: unknown
}

function rejected(): Error {
  return new Error('Ophis OTC order decode rejected')
}

function asRawOrderRow(value: unknown): RawOrderRow {
  if (Array.isArray(value)) {
    if (value.length !== 6) throw rejected()
    return {
      maker: value[0],
      active: value[1],
      tokenA: value[2],
      amountA: value[3],
      tokenB: value[4],
      amountB: value[5],
    }
  }

  if (typeof value !== 'object' || value === null) throw rejected()
  const record = value as Record<string, unknown>
  return {
    maker: record.maker,
    active: record.active,
    tokenA: record.tokenA,
    amountA: record.amountA,
    tokenB: record.tokenB,
    amountB: record.amountB,
  }
}

function asChecksummedAddress(value: unknown): Address {
  if (typeof value !== 'string') throw rejected()
  try {
    return getAddress(value)
  } catch {
    throw rejected()
  }
}

function asAmount(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > maxUint256) throw rejected()
  return value
}

/**
 * Strict validation of decoded getOrders() rows. Settlement-authority data
 * fails closed: any malformed row rejects the whole batch. Rows whose maker
 * is the zero address are the contract's default struct for non-existent
 * order ids and are dropped.
 */
export function parseOtcOrders(decoded: unknown, requestedIds: readonly bigint[]): OtcOrder[] {
  if (!Array.isArray(decoded) || decoded.length !== requestedIds.length) throw rejected()

  const orders: OtcOrder[] = []

  for (const [index, value] of decoded.entries()) {
    const raw = asRawOrderRow(value)
    const maker = asChecksummedAddress(raw.maker)
    if (isAddressEqual(maker, zeroAddress)) continue
    if (typeof raw.active !== 'boolean') throw rejected()

    orders.push({
      orderId: requestedIds[index],
      maker,
      active: raw.active,
      tokenA: asChecksummedAddress(raw.tokenA),
      amountA: asAmount(raw.amountA),
      tokenB: asChecksummedAddress(raw.tokenB),
      amountB: asAmount(raw.amountB),
    })
  }

  return orders
}
