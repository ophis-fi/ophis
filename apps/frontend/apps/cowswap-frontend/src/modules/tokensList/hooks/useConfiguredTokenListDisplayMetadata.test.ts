import { getTokenId, SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  COINBASE_TOKENIZED_STOCKS_LIST_SOURCE,
  DEFAULT_TOKENS_LISTS,
  ListState,
  ONDO_TOKENS_LIST_SOURCE,
  XSTOCKS_TOKENS_LIST_SOURCE,
} from '@cowprotocol/tokens'

import {
  collectConfiguredTokenLists,
  getConfiguredTokenListDisplayMetadata,
  getConfiguredTokenListDisplayMetadataForChain,
  getConfiguredTokenListQueryOptions,
  mergeConfiguredTokenListsWithPersistedFallback,
} from './useConfiguredTokenListDisplayMetadata'

const MAINNET_SOURCE = ONDO_TOKENS_LIST_SOURCE
const ARBITRUM_SOURCE = DEFAULT_TOKENS_LISTS[SupportedChainId.ARBITRUM_ONE]?.[0]?.source ?? 'missing-configured-source'
const XSTOCKS_SOURCE = XSTOCKS_TOKENS_LIST_SOURCE
const USER_SOURCE = 'https://example.invalid/user-list.json'
const SPOOFED_PROVIDER_SOURCE = 'https://example.invalid/configured-list.json'
const MAINNET_TOKEN = {
  chainId: SupportedChainId.MAINNET,
  address: '0x0000000000000000000000000000000000000001',
  decimals: 18,
  symbol: 'ON',
  name: 'Configured token (Ondo Tokenized)',
  tags: ['ondo'],
}
const ARBITRUM_TOKEN = {
  chainId: SupportedChainId.ARBITRUM_ONE,
  address: '0x0000000000000000000000000000000000000002',
  decimals: 18,
  symbol: 'XSTOCK',
  name: 'Configured token xStock',
  tags: ['xStocks'],
}
const USER_TOKEN = {
  chainId: SupportedChainId.MAINNET,
  address: '0x0000000000000000000000000000000000000003',
  decimals: 18,
  symbol: 'USER',
  name: 'User token xStock',
  tags: ['xStocks'],
}
const BASE_STOCK_TOKEN = {
  chainId: SupportedChainId.BASE,
  address: '0xb200000000000000000000C2e324d24d7eEcd1fb',
  decimals: 8,
  symbol: 'AAPLc',
  name: 'Apple Inc.',
  tags: ['coinbase'],
}

function createList(
  source: string,
  token: typeof MAINNET_TOKEN | typeof ARBITRUM_TOKEN | typeof USER_TOKEN | typeof BASE_STOCK_TOKEN,
): ListState {
  return {
    source,
    list: {
      name: source,
      timestamp: '2026-08-19T00:00:00.000Z',
      version: { major: 1, minor: 0, patch: 0 },
      tokens: [token],
      tags: {
        ondo: { name: 'Tokenized by Ondo', description: 'Issued by Ondo' },
        xStocks: { name: 'xStock', description: 'Issued by xStocks' },
        coinbase: { name: 'Coinbase tokenized stock', description: 'B20 token on Base issued by Coinbase' },
      },
    },
  }
}

describe('configured token-list display metadata', () => {
  it('trusts configured list membership and ignores user-added lists', () => {
    const result = getConfiguredTokenListDisplayMetadata(
      [createList(MAINNET_SOURCE, MAINNET_TOKEN), createList(USER_SOURCE, USER_TOKEN)],
      new Set([MAINNET_SOURCE]),
    )

    const configuredTokenId = getTokenId(MAINNET_TOKEN)
    const userTokenId = getTokenId(USER_TOKEN)

    expect(result.listedTokenIds.has(configuredTokenId)).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(configuredTokenId)).toBe('ondo')
    expect(result.tokenListTags.ondo?.name).toBe('Tokenized by Ondo')
    expect(result.listedTokenIds.has(userTokenId)).toBe(false)
    expect(result.tokenizedAssetProviderByTokenId.has(userTokenId)).toBe(false)
  })

  it('includes loaded configured lists from the selected target chain', () => {
    const currentChainList = createList(MAINNET_SOURCE, MAINNET_TOKEN)
    const targetChainList = createList(XSTOCKS_SOURCE, ARBITRUM_TOKEN)

    const result = getConfiguredTokenListDisplayMetadataForChain(
      [currentChainList, targetChainList],
      SupportedChainId.ARBITRUM_ONE,
    )

    expect(result.listedTokenIds.has(getTokenId(ARBITRUM_TOKEN))).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(getTokenId(ARBITRUM_TOKEN))).toBe('xStocks')
    expect(result.tokenListTags.xStocks?.name).toBe('xStock')
    expect(result.listedTokenIds.has(getTokenId(MAINNET_TOKEN))).toBe(false)
  })

  it('trusts the Coinbase provider tag only through the configured Base stock list', () => {
    const configured = getConfiguredTokenListDisplayMetadataForChain(
      [createList(COINBASE_TOKENIZED_STOCKS_LIST_SOURCE, BASE_STOCK_TOKEN)],
      SupportedChainId.BASE,
    )
    const stockTokenId = getTokenId(BASE_STOCK_TOKEN)

    expect(configured.listedTokenIds.has(stockTokenId)).toBe(true)
    expect(configured.tokenizedAssetProviderByTokenId.get(stockTokenId)).toBe('coinbase')
    expect(configured.tokenListTags.coinbase?.name).toBe('Coinbase tokenized stock')

    const spoofed = getConfiguredTokenListDisplayMetadata(
      [createList(SPOOFED_PROVIDER_SOURCE, BASE_STOCK_TOKEN)],
      new Set([SPOOFED_PROVIDER_SOURCE]),
    )
    expect(spoofed.tokenizedAssetProviderByTokenId.has(stockTokenId)).toBe(false)
    expect(spoofed.tokenListTags.coinbase).toBeUndefined()
  })

  it('accepts provider identity only from the matching official provider source', () => {
    const spoofedList = createList(SPOOFED_PROVIDER_SOURCE, MAINNET_TOKEN)
    const result = getConfiguredTokenListDisplayMetadata([spoofedList], new Set([SPOOFED_PROVIDER_SOURCE]))

    expect(result.listedTokenIds.has(getTokenId(MAINNET_TOKEN))).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.has(getTokenId(MAINNET_TOKEN))).toBe(false)
    expect(result.tokenListTags.ondo).toBeUndefined()
  })

  it('gives each configured source an independent cache with an explicit six-hour freshness policy', () => {
    const configuredList = DEFAULT_TOKENS_LISTS[SupportedChainId.ARBITRUM_ONE]?.[0]
    expect(configuredList).toBeDefined()
    if (!configuredList) return

    const options = getConfiguredTokenListQueryOptions(SupportedChainId.ARBITRUM_ONE, configuredList)

    expect(options.queryKey).toEqual([
      'configured-token-list-display-metadata',
      SupportedChainId.ARBITRUM_ONE,
      ARBITRUM_SOURCE,
    ])
    expect(options.staleTime).toBe(6 * 60 * 60 * 1_000)
    expect(options.refetchInterval).toBe(options.staleTime)
    expect(options.refetchOnWindowFocus).toBe(true)
  })

  it('keeps healthy metadata while a failed source remains independently retryable', async () => {
    const healthyConfig = { source: MAINNET_SOURCE }
    const failingConfig = { source: ARBITRUM_SOURCE }
    const healthyList = createList(MAINNET_SOURCE, MAINNET_TOKEN)
    const failure = new Error('temporary list failure')
    const loadTokenList = jest
      .fn<Promise<ListState>, [typeof healthyConfig]>()
      .mockResolvedValueOnce(healthyList)
      .mockRejectedValueOnce(failure)
    const healthyOptions = getConfiguredTokenListQueryOptions(SupportedChainId.MAINNET, healthyConfig, loadTokenList)
    const failingOptions = getConfiguredTokenListQueryOptions(SupportedChainId.MAINNET, failingConfig, loadTokenList)

    await expect(healthyOptions.queryFn()).resolves.toBe(healthyList)
    await expect(failingOptions.queryFn()).rejects.toBe(failure)
    expect(healthyOptions.queryKey).not.toEqual(failingOptions.queryKey)
    expect(collectConfiguredTokenLists([{ data: healthyList }, { data: undefined }])).toEqual([healthyList])
    expect(loadTokenList).toHaveBeenCalledTimes(2)
  })

  it('uses a matching persisted configured list when its query has no data', () => {
    const configuredLists = [{ source: MAINNET_SOURCE }, { source: ARBITRUM_SOURCE }]
    const queriedList = createList(MAINNET_SOURCE, MAINNET_TOKEN)
    const persistedList = createList(ARBITRUM_SOURCE, ARBITRUM_TOKEN)

    expect(
      mergeConfiguredTokenListsWithPersistedFallback(
        [queriedList],
        { [ARBITRUM_SOURCE]: persistedList, [USER_SOURCE]: createList(USER_SOURCE, USER_TOKEN) },
        configuredLists,
      ),
    ).toEqual([queriedList, persistedList])
  })

  it('rejects mismatched and deleted persisted configured-list entries', () => {
    const configuredLists = [{ source: MAINNET_SOURCE }, { source: ARBITRUM_SOURCE }]

    expect(
      mergeConfiguredTokenListsWithPersistedFallback(
        [],
        { [MAINNET_SOURCE]: createList(USER_SOURCE, USER_TOKEN), [ARBITRUM_SOURCE]: 'deleted' },
        configuredLists,
      ),
    ).toEqual([])
  })
})
