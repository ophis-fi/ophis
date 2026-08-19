import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import {
  ListState,
  useAllListsList,
  useTokenListsTags,
  useUnsupportedTokens,
  useUserAddedTokens,
} from '@cowprotocol/tokens'

import { useTokensBalancesCombined } from 'modules/combinedBalances'
import { usePermitCompatibleTokens } from 'modules/permit'

import { useConfiguredTokenListDisplayMetadata } from '../../../hooks/useConfiguredTokenListDisplayMetadata'
import { TokenizedAssetProviderTag } from '../../../types'

export interface TokenDataSources {
  userAddedTokens: TokenWithLogo[]
  allTokenLists: ListState[]
  balancesState: ReturnType<typeof useTokensBalancesCombined>
  unsupportedTokens: ReturnType<typeof useUnsupportedTokens>
  permitCompatibleTokens: ReturnType<typeof usePermitCompatibleTokens>
  tokenListTags: ReturnType<typeof useTokenListsTags>
  listedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
}

export function useTokenDataSources(targetChainId?: number): TokenDataSources {
  const userAddedTokens = useUserAddedTokens()
  const allTokenLists = useAllListsList()
  const balancesState = useTokensBalancesCombined()
  const unsupportedTokens = useUnsupportedTokens()
  const permitCompatibleTokens = usePermitCompatibleTokens()
  const currentChainTokenListTags = useTokenListsTags()
  const {
    listedTokenIds,
    tokenizedAssetProviderByTokenId,
    tokenListTags: targetChainTokenListTags,
  } = useConfiguredTokenListDisplayMetadata(targetChainId)
  const tokenListTags = useMemo(
    () => ({ ...currentChainTokenListTags, ...targetChainTokenListTags }),
    [currentChainTokenListTags, targetChainTokenListTags],
  )

  return useMemo(
    () => ({
      userAddedTokens,
      allTokenLists,
      balancesState,
      unsupportedTokens,
      permitCompatibleTokens,
      tokenListTags,
      listedTokenIds,
      tokenizedAssetProviderByTokenId,
    }),
    [
      userAddedTokens,
      allTokenLists,
      balancesState,
      unsupportedTokens,
      permitCompatibleTokens,
      tokenListTags,
      listedTokenIds,
      tokenizedAssetProviderByTokenId,
    ],
  )
}
