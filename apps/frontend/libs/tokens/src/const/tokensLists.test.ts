import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  COINBASE_TOKENIZED_STOCKS_LIST_SOURCE,
  DEFAULT_TOKENS_LISTS,
  ONDO_TOKENS_LIST_SOURCE,
  RWA_TOKENS_LIST_SOURCES,
  XSTOCKS_TOKENS_LIST_SOURCE,
} from './tokensLists'

import { validateTokenList } from '../utils/validateTokenList'

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

it('enables the issuer stock registry and Pons catalog on Robinhood Chain', () => {
  const lists = DEFAULT_TOKENS_LISTS[4663 as unknown as SupportedChainId]
  expect(lists.find((list) => list.source.endsWith('/api/robinhood/assets?format=token-list'))).toEqual({
    priority: 0,
    enabledByDefault: true,
    source: 'https://swap.ophis.fi/api/robinhood/assets?format=token-list',
  })
  expect(lists.find((list) => list.source.endsWith('/api/pons-token-list'))?.enabledByDefault).toBe(true)
})

it('enables the verified Tiny Humans deployment with its own artwork', async () => {
  const list = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../apps/cowswap-frontend/public/token-lists/robinhood.json'), 'utf8'),
  )
  await validateTokenList(list)
  expect(list.tokens).toEqual([
    expect.objectContaining({
      chainId: 4663,
      address: '0xb9CE619b168f325b4eb8C2E8E073501838C7A407',
      name: 'Tiny Humans AI',
      symbol: 'TINY',
      decimals: 18,
      logoURI: 'https://swap.ophis.fi/logos/token-tiny.png',
    }),
  ])
  expect(
    DEFAULT_TOKENS_LISTS[4663 as unknown as SupportedChainId].find(
      (list) => list.source === 'https://swap.ophis.fi/token-lists/robinhood.json',
    )?.enabledByDefault,
  ).toBe(true)
})
