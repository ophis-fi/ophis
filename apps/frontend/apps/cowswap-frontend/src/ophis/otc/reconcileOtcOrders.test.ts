import { reconcileOtcOrders } from './reconcileOtcOrders'

import type { OtcIndexedOrder, OtcOrder, OtcOrderField, OtcSnapshot } from './otc.types'

const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const OTHER = '0x2eDecb91091324e0138EBBBaEd48ce1B2A050428'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function onchainOrder(orderId: bigint, overrides: Partial<OtcOrder> = {}): OtcOrder {
  return {
    orderId,
    maker: MAKER,
    active: true,
    tokenA: WETH,
    amountA: 1_000_000_000_000_000_000n,
    tokenB: USDC,
    amountB: 4_000_000_000n,
    ...overrides,
  }
}

function indexedOrder(orderId: bigint, overrides: Partial<OtcIndexedOrder> = {}): OtcIndexedOrder {
  return {
    ...onchainOrder(orderId),
    createdAt: 1_755_000_000,
    createdTx: '0xc074a1fe0000000000000000000000000000000000000000000000000000000000004cad',
    taker: null,
    filledAt: null,
    filledTx: null,
    cancelledAt: null,
    cancelledTx: null,
    ...overrides,
  }
}

function snapshot(orders: OtcOrder[], overrides: Partial<OtcSnapshot> = {}): OtcSnapshot {
  const maxId = orders.reduce((max, order) => (order.orderId > max ? order.orderId : max), 0n)
  return {
    chainId: 1,
    blockNumber: 25_787_579n,
    blockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    nextOrderId: maxId + 1n,
    orders,
    truncated: false,
    ...overrides,
  }
}

describe('reconcileOtcOrders', () => {
  it('verifies orders whose indexed terms exactly match on-chain state', () => {
    const report = reconcileOtcOrders(
      [indexedOrder(1n), indexedOrder(0n)],
      snapshot([onchainOrder(1n), onchainOrder(0n)]),
    )
    expect(report.verifiedIds).toEqual([0n, 1n])
    expect(report.mismatches).toEqual([])
    expect(report.missingOnchain).toEqual([])
    expect(report.notIndexed).toEqual([])
    expect(report.unknownIds).toEqual([])
  })

  it.each<[OtcOrderField, Partial<OtcIndexedOrder>]>([
    ['maker', { maker: OTHER }],
    ['tokenA', { tokenA: USDC }],
    ['amountA', { amountA: 999n }],
    ['tokenB', { tokenB: WETH }],
    ['amountB', { amountB: 999n }],
  ])('detects a mutation of the immutable field %s as corruption', (field, mutation) => {
    const report = reconcileOtcOrders([indexedOrder(1n, mutation)], snapshot([onchainOrder(1n)]))
    expect(report.verifiedIds).toEqual([])
    expect(report.activeLagIds).toEqual([])
    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0].orderId).toBe(1n)
    expect(report.mismatches[0].field).toBe(field)
    expect(report.mismatches[0].indexed).not.toBe(report.mismatches[0].onchain)
  })

  it('reports an active-flag disagreement as index lag, never verified and never corruption', () => {
    const report = reconcileOtcOrders([indexedOrder(1n, { active: false })], snapshot([onchainOrder(1n)]))
    expect(report.verifiedIds).toEqual([])
    expect(report.mismatches).toEqual([])
    expect(report.activeLagIds).toEqual([1n])
  })

  it('reports an active disagreement combined with immutable corruption as corruption', () => {
    const report = reconcileOtcOrders(
      [indexedOrder(1n, { active: false, amountB: 999n })],
      snapshot([onchainOrder(1n)]),
    )
    expect(report.verifiedIds).toEqual([])
    expect(report.activeLagIds).toEqual([])
    expect(report.mismatches.map((entry) => entry.field)).toEqual(['amountB'])
  })

  it('treats address-case differences as equal', () => {
    const report = reconcileOtcOrders(
      [indexedOrder(1n, { maker: MAKER.toLowerCase() as OtcIndexedOrder['maker'] })],
      snapshot([onchainOrder(1n)]),
    )
    expect(report.verifiedIds).toEqual([1n])
    expect(report.mismatches).toEqual([])
  })

  it('reports indexed ids the chain does not have inside the enumerated window', () => {
    const report = reconcileOtcOrders(
      [indexedOrder(1n), indexedOrder(2n)],
      snapshot([onchainOrder(1n)], { nextOrderId: 3n }),
    )
    expect(report.missingOnchain).toEqual([2n])
  })

  it('reports on-chain ids missing from the index', () => {
    const report = reconcileOtcOrders([indexedOrder(1n)], snapshot([onchainOrder(1n), onchainOrder(2n)]))
    expect(report.notIndexed).toEqual([2n])
  })

  it('never verifies indexed ids outside a truncated enumeration window', () => {
    // window covers ids 5..9 only (nextOrderId 10, 5 enumerated orders)
    const onchain = [9n, 8n, 7n, 6n, 5n].map((id) => onchainOrder(id))
    const report = reconcileOtcOrders(
      [indexedOrder(9n), indexedOrder(3n)],
      snapshot(onchain, { nextOrderId: 10n, truncated: true }),
    )
    expect(report.verifiedIds).toEqual([9n])
    expect(report.unknownIds).toEqual([3n])
    expect(report.missingOnchain).toEqual([])
  })
})
