import { COINBASE_TOKENIZED_STOCKS_LIST_SOURCE } from '@cowprotocol/tokens'

import {
  findCoinbaseStockAsset,
  formatMultiplierLabel,
  isCoinbaseStockAddress,
  isInLoadedCoinbaseList,
  isUnitMultiplier,
  needsAttention,
  parseCoinbaseStockAssets,
  scaleByMultiplier,
  selectStockAssets,
} from './data'

import type { CoinbaseStockAsset } from './types'

const AAPLC = '0xb200000000000000000000C2e324d24d7eEcd1fb'
const TSLAC = '0xb2000000000000000000001e800a7f5189430cD0'

const aapl: CoinbaseStockAsset = {
  address: AAPLC,
  symbol: 'AAPLc',
  name: 'Apple Inc.',
  multiplier: '1.000000000000000000',
  issued: true,
  transfersPaused: false,
}
const tsla: CoinbaseStockAsset = { ...aapl, address: TSLAC, symbol: 'TSLAc', name: 'Tesla Inc.', issued: false }

describe('isCoinbaseStockAddress', () => {
  it('recognises every shipped stock by address on Base, independent of any loaded token list', () => {
    expect(isCoinbaseStockAddress(8453, AAPLC)).toBe(true)
    expect(isCoinbaseStockAddress(8453, AAPLC.toLowerCase())).toBe(true)
    expect(isCoinbaseStockAddress(8453, TSLAC)).toBe(true)
  })

  it('ignores other chains, other tokens, and undefined', () => {
    expect(isCoinbaseStockAddress(1, AAPLC)).toBe(false)
    expect(isCoinbaseStockAddress(8453, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false)
    expect(isCoinbaseStockAddress(8453, undefined)).toBe(false)
  })
})

describe('isInLoadedCoinbaseList', () => {
  const NEW_STOCK = '0xb2000000000000000000000000000000000000AA'
  const listStates = {
    [COINBASE_TOKENIZED_STOCKS_LIST_SOURCE]: {
      source: COINBASE_TOKENIZED_STOCKS_LIST_SOURCE,
      list: { tokens: [{ chainId: 8453, address: NEW_STOCK, symbol: 'NEWc', name: 'New Inc.', decimals: 8 }] },
    },
    'https://example.invalid/other.json': {
      source: 'https://example.invalid/other.json',
      list: { tokens: [{ chainId: 8453, address: AAPLC, symbol: 'AAPLC', name: 'Apple', decimals: 8 }] },
    },
  }

  it('sees a stock added to the refreshed official list even when the bundle predates it', () => {
    expect(isInLoadedCoinbaseList(listStates, 8453, NEW_STOCK.toLowerCase())).toBe(true)
  })

  it('only trusts the official Coinbase list source, on Base, when it is loaded', () => {
    expect(isInLoadedCoinbaseList(listStates, 8453, AAPLC)).toBe(false)
    expect(isInLoadedCoinbaseList(listStates, 1, NEW_STOCK)).toBe(false)
    expect(isInLoadedCoinbaseList({}, 8453, NEW_STOCK)).toBe(false)
    expect(isInLoadedCoinbaseList(listStates, 8453, undefined)).toBe(false)
  })
})

describe('findCoinbaseStockAsset', () => {
  it('matches by address regardless of checksum casing and ignores unknown addresses', () => {
    expect(findCoinbaseStockAsset([aapl, tsla], AAPLC.toLowerCase())).toBe(aapl)
    expect(findCoinbaseStockAsset([aapl, tsla], TSLAC)).toBe(tsla)
    expect(findCoinbaseStockAsset([aapl, tsla], '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBeUndefined()
    expect(findCoinbaseStockAsset([aapl, tsla], undefined)).toBeUndefined()
  })
})

describe('multiplier helpers', () => {
  it('scales a raw balance by the WAD-precision multiplier string', () => {
    expect(scaleByMultiplier(100_000_000n, '1.020000000000000000')).toBe(102_000_000n)
    expect(scaleByMultiplier(100_000_000n, '10.000000000000000000')).toBe(1_000_000_000n)
    expect(scaleByMultiplier(100_000_000n, '1.000000000000000000')).toBe(100_000_000n)
  })

  it('recognises the identity multiplier so the panel can skip the share-equivalent line', () => {
    expect(isUnitMultiplier('1.000000000000000000')).toBe(true)
    expect(isUnitMultiplier('1')).toBe(true)
    expect(isUnitMultiplier('1.020000000000000000')).toBe(false)
  })
})

describe('selectStockAssets', () => {
  it('returns the distinct stock assets on either side of the pair, sell side first', () => {
    expect(selectStockAssets([aapl, tsla], undefined, AAPLC)).toEqual([aapl])
    expect(selectStockAssets([aapl, tsla], TSLAC, AAPLC.toLowerCase())).toEqual([tsla, aapl])
    expect(selectStockAssets([aapl, tsla], AAPLC, AAPLC)).toEqual([aapl])
    expect(selectStockAssets([aapl, tsla], '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', undefined)).toEqual([])
  })
})

describe('formatMultiplierLabel', () => {
  it('trims the 18-decimal multiplier to a readable factor', () => {
    expect(formatMultiplierLabel('1.000000000000000000')).toBe('1')
    expect(formatMultiplierLabel('1.020000000000000000')).toBe('1.02')
    expect(formatMultiplierLabel('10.000000000000000000')).toBe('10')
    expect(formatMultiplierLabel('1.234567891234567891')).toBe('1.234568')
  })
})

describe('needsAttention', () => {
  it('flags paused transfers, unissued stocks and non-unit multipliers', () => {
    expect(needsAttention(aapl)).toBe(false)
    expect(needsAttention(tsla)).toBe(true)
    expect(needsAttention({ ...aapl, transfersPaused: true })).toBe(true)
    expect(needsAttention({ ...aapl, multiplier: '1.020000000000000000' })).toBe(true)
  })
})

describe('parseCoinbaseStockAssets', () => {
  it('accepts the documented endpoint payload', () => {
    expect(parseCoinbaseStockAssets({ chainId: 8453, assets: [aapl, tsla] })).toEqual([aapl, tsla])
  })

  it('fails closed on a malformed payload instead of rendering partial metadata', () => {
    expect(() => parseCoinbaseStockAssets({ assets: 'nope' })).toThrow()
    expect(() => parseCoinbaseStockAssets({ chainId: 8453, assets: [{ ...aapl, multiplier: 'one' }] })).toThrow()
    expect(() => parseCoinbaseStockAssets({ chainId: 8453, assets: [{ ...aapl, issued: 'yes' }] })).toThrow()
    expect(() => parseCoinbaseStockAssets({ chainId: 8453, assets: [{ ...aapl, address: 'javascript:1' }] })).toThrow()
    expect(() => parseCoinbaseStockAssets({ chainId: 1, assets: [aapl] })).toThrow()
    expect(() => parseCoinbaseStockAssets(null)).toThrow()
  })
})
