import { getTokenId, SupportedChainId } from '@cowprotocol/cow-sdk'
import { DEFAULT_TOKENS_LISTS, ListState, TokenListsByChainState } from '@cowprotocol/tokens'

import {
  getConfiguredTokenListDisplayMetadata,
  getConfiguredTokenListDisplayMetadataForChain,
  getMissingConfiguredTokenLists,
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
    const listsStatesByChain = {
      [SupportedChainId.ARBITRUM_ONE]: { [ARBITRUM_SOURCE]: targetChainList },
    } as TokenListsByChainState

    const result = getConfiguredTokenListDisplayMetadataForChain(
      [currentChainList],
      listsStatesByChain,
      SupportedChainId.ARBITRUM_ONE,
    )

    expect(result.verifiedTokenIds.has(getTokenId(ARBITRUM_TOKEN))).toBe(true)
    expect(result.tokenizedAssetProviderByTokenId.get(getTokenId(ARBITRUM_TOKEN))).toBe('xStocks')
    expect(result.tokenListTags.xStocks?.name).toBe('xStock')
    expect(result.verifiedTokenIds.has(getTokenId(MAINNET_TOKEN))).toBe(false)
  })

  it('requests configured target lists that have not been loaded yet', () => {
    const missingLists = getMissingConfiguredTokenLists(
      [createList(MAINNET_SOURCE, MAINNET_TOKEN)],
      {} as TokenListsByChainState,
      SupportedChainId.ARBITRUM_ONE,
    )

    expect(missingLists.map(({ source }) => source)).toContain(ARBITRUM_SOURCE)
  })

  it('does not refetch configured target lists that are already loaded', () => {
    const targetChainList = createList(ARBITRUM_SOURCE, ARBITRUM_TOKEN)
    const listsStatesByChain = {
      [SupportedChainId.ARBITRUM_ONE]: { [ARBITRUM_SOURCE]: targetChainList },
    } as TokenListsByChainState

    const missingLists = getMissingConfiguredTokenLists([], listsStatesByChain, SupportedChainId.ARBITRUM_ONE)

    expect(missingLists.map(({ source }) => source)).not.toContain(ARBITRUM_SOURCE)
  })
})
