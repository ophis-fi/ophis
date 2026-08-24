import { SupportedChainId } from '@cowprotocol/cow-sdk'

import {
  COINBASE_TOKENIZED_STOCKS_LIST_SOURCE,
  DEFAULT_TOKENS_LISTS,
  ONDO_TOKENS_LIST_SOURCE,
  RWA_TOKENS_LIST_SOURCES,
  XSTOCKS_TOKENS_LIST_SOURCE,
} from './tokensLists'

describe('Base default token lists', () => {
  const baseLists = DEFAULT_TOKENS_LISTS[SupportedChainId.BASE] ?? []

  it('ships the Coinbase tokenized-stocks list enabled by default with top precedence', () => {
    const entry = baseLists.find((list) => list.source === COINBASE_TOKENIZED_STOCKS_LIST_SOURCE)

    expect(entry).toEqual({ priority: 0, enabledByDefault: true, source: COINBASE_TOKENIZED_STOCKS_LIST_SOURCE })

    // Every other Base list must sort after it so the on-chain symbol (AAPLc) and the
    // official logo win the first-write-wins merge over CoinGecko's AAPLC entry.
    const otherPriorities = baseLists.filter((list) => list !== entry).map((list) => list.priority ?? Infinity)
    expect(Math.min(...otherPriorities)).toBeGreaterThan(0)
  })

  it('serves the list from the Ophis origin, next to the pons list precedent', () => {
    expect(COINBASE_TOKENIZED_STOCKS_LIST_SOURCE).toBe(
      'https://swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json',
    )
  })

  it('does not treat 24/7 B20 stocks as weekend-closed RWA lists', () => {
    expect(RWA_TOKENS_LIST_SOURCES).not.toContain(COINBASE_TOKENIZED_STOCKS_LIST_SOURCE)
  })

  it('leaves the positionally-pinned mainnet RWA sources untouched', () => {
    expect(ONDO_TOKENS_LIST_SOURCE).toContain('ondoprotocol')
    expect(XSTOCKS_TOKENS_LIST_SOURCE).toContain('backed-fi')
  })
})
