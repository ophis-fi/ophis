import { getTokenId, SupportedChainId } from '@cowprotocol/cow-sdk'
import { DEFAULT_TOKENS_LISTS, ListState } from '@cowprotocol/tokens'

import {
  getConfiguredTokenListDisplayMetadata,
  getConfiguredTokenListDisplayMetadataForChain,
  getConfiguredTokenListsQueryOptions,
  fetchConfiguredTokenLists,
} from './useConfiguredTokenListDisplayMetadata'

const MAINNET_SOURCE = 'https://tokens.ophis.fi/default.json'
const ARBITRUM_SOURCE = DEFAULT_TOKENS_LISTS[SupportedChainId.ARBITRUM_ONE]?.[0]?.source ?? 'missing-configured-source'
const USER_SOURCE = 'https://example.invalid/user-list.json'
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

function createList(
  source: string,
  token: typeof MAINNET_TOKEN | typeof ARBITRUM_TOKEN | typeof USER_TOKEN,
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

    expect(result.verifiedTokenIds.has(configuredTokenId)).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(configuredTokenId)).toBe('ondo')
    expect(result.tokenListTags.ondo?.name).toBe('Tokenized by Ondo')
    expect(result.verifiedTokenIds.has(userTokenId)).toBe(false)
    expect(result.tokenizedAssetProviderByTokenId.has(userTokenId)).toBe(false)
  })

  it('includes loaded configured lists from the selected target chain', () => {
    const currentChainList = createList(MAINNET_SOURCE, MAINNET_TOKEN)
    const targetChainList = createList(ARBITRUM_SOURCE, ARBITRUM_TOKEN)

    const result = getConfiguredTokenListDisplayMetadataForChain(
      [currentChainList, targetChainList],
      SupportedChainId.ARBITRUM_ONE,
    )

    expect(result.verifiedTokenIds.has(getTokenId(ARBITRUM_TOKEN))).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(getTokenId(ARBITRUM_TOKEN))).toBe('xStocks')
    expect(result.tokenListTags.xStocks?.name).toBe('xStock')
    expect(result.verifiedTokenIds.has(getTokenId(MAINNET_TOKEN))).toBe(false)
  })

  it('uses a shared query cache with an explicit six-hour freshness policy', () => {
    const options = getConfiguredTokenListsQueryOptions(SupportedChainId.ARBITRUM_ONE)

    expect(options.queryKey).toEqual([
      'configured-token-list-display-metadata',
      SupportedChainId.ARBITRUM_ONE,
      expect.arrayContaining([ARBITRUM_SOURCE]),
    ])
    expect(options.enabled).toBe(true)
    expect(options.staleTime).toBe(6 * 60 * 60 * 1_000)
    expect(options.refetchInterval).toBe(options.staleTime)
    expect(options.refetchOnWindowFocus).toBe(true)
  })

  it('rejects a configured-list refresh when any source fails so the query can retry', async () => {
    const configuredLists = [{ source: MAINNET_SOURCE }, { source: ARBITRUM_SOURCE }]
    const failure = new Error('temporary list failure')
    const loadTokenList = jest
      .fn<Promise<ListState>, [(typeof configuredLists)[number]]>()
      .mockResolvedValueOnce(createList(MAINNET_SOURCE, MAINNET_TOKEN))
      .mockRejectedValueOnce(failure)

    await expect(fetchConfiguredTokenLists(configuredLists, loadTokenList)).rejects.toBe(failure)
    expect(loadTokenList).toHaveBeenCalledTimes(2)
  })
})
