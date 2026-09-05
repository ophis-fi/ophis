import { applyBrowseFilters } from './otcBrowseFilters.utils'
import { buildOtcDisplayRows, filterBrowseRows, filterMakerRows, getOtcAge } from './otcDisplay'

import type { OtcDataState, OtcIndexedOrder, OtcOrder, OtcSnapshot } from 'ophis/otc'

const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const OTHER = '0x2eDecb91091324e0138EBBBaEd48ce1B2A050428'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const ZAMM = '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED'

function order(orderId: bigint, overrides: Partial<OtcOrder> = {}): OtcOrder {
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

function indexedRow(orderId: bigint, overrides: Partial<OtcIndexedOrder> = {}): OtcIndexedOrder {
  return {
    ...order(orderId),
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

function readyState(): OtcDataState {
  const orders = [
    order(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    order(2n),
    order(1n, { maker: OTHER, active: false }),
    order(0n, { active: false }),
  ]
  const snapshot: OtcSnapshot = {
    chainId: 1,
    blockNumber: 1_000n,
    blockHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    nextOrderId: 4n,
    orders,
    truncated: false,
  }
  const indexed = [
    indexedRow(3n, { tokenA: ZAMM, amountA: 100_000_000_000_000_000_000n, tokenB: WETH, amountB: 10n ** 18n }),
    indexedRow(2n, { amountB: 999n }), // disagrees with chain -> mismatch
    indexedRow(1n, {
      maker: OTHER,
      active: false,
      filledAt: 1_755_100_000,
      filledTx: indexedRow(1n).createdTx,
      taker: OTHER,
    }),
    indexedRow(0n, { active: false, cancelledAt: 1_755_200_000, cancelledTx: indexedRow(0n).createdTx }),
  ]
  return {
    status: 'ready',
    degradedReason: null,
    snapshot,
    enrichment: { byOrderId: new Map(indexed.map((row) => [row.orderId.toString(), row])), indexedBlock: 999n },
    reconciliation: {
      verifiedIds: [0n, 1n, 3n],
      mismatches: [{ orderId: 2n, field: 'amountB', indexed: '999', onchain: '4000000000' }],
      missingOnchain: [],
      notIndexed: [],
      unknownIds: [],
      activeLagIds: [],
    },
    indexLagBlocks: 1n,
  }
}

describe('buildOtcDisplayRows', () => {
  it('builds newest-first rows with review, verification, and resolution states', () => {
    const rows = buildOtcDisplayRows(readyState())
    expect(rows.map((row) => row.order.orderId)).toEqual([3n, 2n, 1n, 0n])

    const [unreviewed, mismatched, filled, cancelled] = rows
    expect(unreviewed.reviewed).toBe(false)
    expect(unreviewed.verified).toBe(true)
    expect(unreviewed.rate).toBeNull()
    expect(unreviewed.resolution).toBe('active')

    expect(mismatched.reviewed).toBe(true)
    expect(mismatched.verified).toBe(false)
    expect(mismatched.mismatch).toBe(true)
    expect(mismatched.rate?.rate).toBe('4000')

    // chain-authoritative status only; lifecycle survives as a labeled index claim
    expect(filled.resolution).toBe('inactive')
    expect(filled.indexClaim).toBe('filled')
    expect(cancelled.resolution).toBe('inactive')
    expect(cancelled.indexClaim).toBe('cancelled')
    expect(filled.createdAt).toBe(1_755_000_000)
  })

  it('marks resolution inactive and age unknown without enrichment', () => {
    const state = { ...readyState(), enrichment: null, reconciliation: null, status: 'degraded' as const }
    const rows = buildOtcDisplayRows(state)
    expect(rows[2].resolution).toBe('inactive')
    expect(rows[2].indexClaim).toBeNull()
    expect(rows[2].createdAt).toBeNull()
    expect(rows[0].verified).toBe(false)
  })

  it('never promotes an index lifecycle claim to authoritative status', () => {
    const rows = buildOtcDisplayRows(readyState())
    // every inactive row stays Inactive regardless of index claims
    for (const row of rows.filter((r) => !r.order.active)) {
      expect(row.resolution).toBe('inactive')
    }
  })

  it('returns no rows without a snapshot', () => {
    const state: OtcDataState = {
      status: 'unavailable',
      degradedReason: null,
      snapshot: null,
      enrichment: null,
      reconciliation: null,
      indexLagBlocks: null,
    }
    expect(buildOtcDisplayRows(state)).toEqual([])
  })
})

describe('filters', () => {
  it('browse keeps only active ALLOWLISTED orders', () => {
    // id 3 is active but carries an unreviewed token: excluded from Browse
    const rows = filterBrowseRows(buildOtcDisplayRows(readyState()))
    expect(rows.map((row) => row.order.orderId)).toEqual([2n])
  })

  it('maker view keeps all of the connected wallet orders, case-insensitively', () => {
    const rows = filterMakerRows(buildOtcDisplayRows(readyState()), MAKER.toLowerCase())
    expect(rows.map((row) => row.order.orderId)).toEqual([3n, 2n, 0n])
  })

  it('uses canonical address equality for an exact token filter', () => {
    const rows = buildOtcDisplayRows(readyState())
    const filtered = applyBrowseFilters(rows, { token: USDC.toLowerCase(), maker: '', orderId: '' })

    expect(filtered.map((row) => row.order.orderId)).toEqual([2n, 1n, 0n])
  })
})

describe('getOtcAge', () => {
  const nowMs = 1_755_000_000_000 + 3 * 60 * 60 * 1_000 // three hours after createdAt

  it('renders relative ages and an em dash for unknown', () => {
    expect(getOtcAge(nowMs, 1_755_000_000)).toEqual({ value: 3, unit: 'hours' })
    expect(getOtcAge(nowMs, 1_755_000_000 - 3 * 24 * 60 * 60)).toEqual({ value: 3, unit: 'days' })
    expect(getOtcAge(1_755_000_000_000 + 5 * 60_000, 1_755_000_000)).toEqual({ value: 5, unit: 'minutes' })
    expect(getOtcAge(nowMs, null)).toBeNull()
  })
})
