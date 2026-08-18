import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { getTokenId } from '@cowprotocol/cow-sdk'
import {
  DEFAULT_TOKENS_LISTS,
  ListState,
  useAllListsList,
  useTokenListsTags,
  useUnsupportedTokens,
  useUserAddedTokens,
} from '@cowprotocol/tokens'

import { useTokensBalancesCombined } from 'modules/combinedBalances'
import { usePermitCompatibleTokens } from 'modules/permit'

import { TokenizedAssetProviderTag } from '../../../types'

export interface TokenDataSources {
  userAddedTokens: TokenWithLogo[]
  allTokenLists: ListState[]
  balancesState: ReturnType<typeof useTokensBalancesCombined>
  unsupportedTokens: ReturnType<typeof useUnsupportedTokens>
  permitCompatibleTokens: ReturnType<typeof usePermitCompatibleTokens>
  tokenListTags: ReturnType<typeof useTokenListsTags>
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
}

const TOKENIZED_ASSET_PROVIDER_TAGS: readonly TokenizedAssetProviderTag[] = ['ondo', 'xStocks']
const CONFIGURED_TOKEN_LIST_SOURCES = new Set(
  Object.values(DEFAULT_TOKENS_LISTS).flatMap((lists) => lists?.map(({ source }) => source) ?? []),
)

export function getConfiguredTokenListDisplayMetadata(
  tokenLists: readonly ListState[],
  configuredSources: ReadonlySet<string> = CONFIGURED_TOKEN_LIST_SOURCES,
): Pick<TokenDataSources, 'verifiedTokenIds' | 'tokenizedAssetProviderByTokenId'> {
  const tokenIds = new Set<string>()
  const providerByTokenId = new Map<string, TokenizedAssetProviderTag>()

  for (const tokenList of tokenLists) {
    if (!configuredSources.has(tokenList.source)) continue

    for (const token of tokenList.list.tokens) {
      const tokenId = getTokenId({ chainId: token.chainId, address: token.address })
      tokenIds.add(tokenId)

      const providerTag = TOKENIZED_ASSET_PROVIDER_TAGS.find((tag) => token.tags?.includes(tag))
      if (providerTag) providerByTokenId.set(tokenId, providerTag)
    }
  }

  return { verifiedTokenIds: tokenIds, tokenizedAssetProviderByTokenId: providerByTokenId }
}

export function useTokenDataSources(): TokenDataSources {
  const userAddedTokens = useUserAddedTokens()
  const allTokenLists = useAllListsList()
  const balancesState = useTokensBalancesCombined()
  const unsupportedTokens = useUnsupportedTokens()
  const permitCompatibleTokens = usePermitCompatibleTokens()
  const tokenListTags = useTokenListsTags()
  const { verifiedTokenIds, tokenizedAssetProviderByTokenId } = useMemo(
    () => getConfiguredTokenListDisplayMetadata(allTokenLists),
    [allTokenLists],
  )

  return useMemo(
    () => ({
      userAddedTokens,
      allTokenLists,
      balancesState,
      unsupportedTokens,
      permitCompatibleTokens,
      tokenListTags,
      verifiedTokenIds,
      tokenizedAssetProviderByTokenId,
    }),
    [
      userAddedTokens,
      allTokenLists,
      balancesState,
      unsupportedTokens,
      permitCompatibleTokens,
      tokenListTags,
      verifiedTokenIds,
      tokenizedAssetProviderByTokenId,
    ],
  )
}
