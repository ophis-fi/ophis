import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { ListState, TokenListTags } from '@cowprotocol/tokens'

import { useManageWidgetVisibility } from './useManageWidgetVisibility'
import { useTokenDataSources } from './useTokenDataSources'

import { useSourceChainId } from '../../../hooks/useSourceChainId'
import { TokenizedAssetProviderTag } from '../../../types'

export interface ManageViewState {
  lists: ListState[]
  customTokens: TokenWithLogo[]
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  tokenListTags: TokenListTags
  onBack: () => void
}

export function useManageViewState(): ManageViewState | null {
  const { isManageWidgetOpen, closeManageWidget } = useManageWidgetVisibility()
  const { chainId } = useSourceChainId()
  const tokenData = useTokenDataSources(chainId)

  return useMemo(() => {
    if (!isManageWidgetOpen) return null

    return {
      lists: tokenData.allTokenLists,
      customTokens: tokenData.userAddedTokens,
      verifiedTokenIds: tokenData.verifiedTokenIds,
      tokenizedAssetProviderByTokenId: tokenData.tokenizedAssetProviderByTokenId,
      tokenListTags: tokenData.tokenListTags,
      onBack: closeManageWidget,
    }
  }, [
    isManageWidgetOpen,
    tokenData.allTokenLists,
    tokenData.userAddedTokens,
    tokenData.verifiedTokenIds,
    tokenData.tokenizedAssetProviderByTokenId,
    tokenData.tokenListTags,
    closeManageWidget,
  ])
}
