import { getTokenId, SupportedChainId } from '@cowprotocol/cow-sdk'
import { DEFAULT_TOKENS_LISTS, ListState, OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'

import {
  getConfiguredTokenListDisplayMetadata,
  getConfiguredTokenListDisplayMetadataForChain,
} from './useConfiguredTokenListDisplayMetadata'

import { LISTED_STOCK_PROVIDERS } from '../const/listedStockProviders.const'
import { getTokenDisplayName } from '../pure/TokenInfo/getTokenDisplayName.utils'
import { getTrustedTokenTags } from '../pure/TokenTags/getTrustedTokenTags.utils'

const STOCKS = [
  { provider: LISTED_STOCK_PROVIDERS[0], name: 'Tesla (bStocks Tokenized Stock)', symbol: 'TSLAB', display: 'Tesla' },
  { provider: LISTED_STOCK_PROVIDERS[1], name: 'Apple (Reality Protocol)', symbol: 'RAAPL', display: 'Apple' },
  { provider: LISTED_STOCK_PROVIDERS[1], name: 'Nvidia rStock', symbol: 'RNVDA', display: 'Nvidia' },
] as const

function createList(stock: (typeof STOCKS)[number]): ListState {
  return {
    source: stock.provider.source,
    list: {
      name: 'Configured CoinGecko list',
      timestamp: '2026-09-26T00:00:00.000Z',
      version: { major: 1, minor: 0, patch: 0 },
      tokens: [
        {
          chainId: stock.provider.chainId,
          address: '0x0000000000000000000000000000000000000001',
          name: stock.name,
          symbol: stock.symbol,
          decimals: 18,
        },
      ],
    },
  }
}

describe('listed stock provider badges', () => {
  it.each(STOCKS)('labels $symbol from the configured chain-specific feed', (stock) => {
    expect(DEFAULT_TOKENS_LISTS[stock.provider.chainId]).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: stock.provider.source, enabledByDefault: true })]),
    )
    const list = createList(stock)
    const token = list.list.tokens[0]
    const result = getConfiguredTokenListDisplayMetadataForChain([list], stock.provider.chainId)
    const provider = result.tokenizedAssetProviderByTokenId.get(getTokenId(token))

    expect(provider).toBe(stock.provider.id)
    expect(getTokenDisplayName(token.name, provider)).toBe(stock.display)
    expect(getTrustedTokenTags([], result.tokenListTags, provider)).toEqual([
      expect.objectContaining({ id: stock.provider.id, name: stock.provider.name }),
    ])
    expect(
      result.tokenizedAssetProviderByTokenId.has(
        getTokenId({ ...token, address: '0x0000000000000000000000000000000000000002' }),
      ),
    ).toBe(false)
    expect(
      result.tokenizedAssetProviderByTokenId.has(getTokenId({ ...token, chainId: SupportedChainId.MAINNET })),
    ).toBe(false)
  })

  it.each(STOCKS)('rejects lookalike names and tags outside the trusted feed for $symbol', (stock) => {
    for (const source of [
      OPHIS_TOKENS_LIST_SOURCE,
      'https://example.invalid/user-list.json',
      `${stock.provider.source}?fake`,
    ]) {
      const list = createList(stock)
      list.source = source
      list.list.tokens[0].tags = [stock.provider.id]
      const result = getConfiguredTokenListDisplayMetadata([list], new Set([source]))
      expect(result.tokenizedAssetProviderByTokenId.size).toBe(0)
      expect(result.tokenListTags[stock.provider.id]).toBeUndefined()
    }
  })

  it.each(STOCKS)('rejects the wrong chain, an unconfigured source, and ordinary tokens for $symbol', (stock) => {
    const list = createList(stock)
    expect(getConfiguredTokenListDisplayMetadata([list], new Set()).tokenizedAssetProviderByTokenId.size).toBe(0)
    const otherChain =
      stock.provider.chainId === SupportedChainId.BNB ? SupportedChainId.ARBITRUM_ONE : SupportedChainId.BNB
    expect(getConfiguredTokenListDisplayMetadataForChain([list], otherChain).tokenizedAssetProviderByTokenId.size).toBe(
      0,
    )

    list.list.tokens[0].chainId = otherChain
    expect(getConfiguredTokenListDisplayMetadata([list]).tokenizedAssetProviderByTokenId.size).toBe(0)
    list.list.tokens[0].chainId = stock.provider.chainId
    list.list.tokens[0].name = 'Unrelated stock token'
    list.list.tokens[0].tags = [stock.provider.id]
    expect(getConfiguredTokenListDisplayMetadata([list]).tokenizedAssetProviderByTokenId.size).toBe(0)
  })
})
