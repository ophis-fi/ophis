import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { ListState } from '@cowprotocol/tokens'

import { useManageWidgetVisibility } from './useManageWidgetVisibility'
import { useTokenDataSources } from './useTokenDataSources'

import { TokenizedAssetProviderTag } from '../../../types'

export interface ManageViewState {
  lists: ListState[]
  customTokens: TokenWithLogo[]
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  onBack: () => void
}

export function useManageViewState(): ManageViewState | null {
  const { isManageWidgetOpen, closeManageWidget } = useManageWidgetVisibility()
  const tokenData = useTokenDataSources()

  return useMemo(() => {
    if (!isManageWidgetOpen) return null

    return {
      lists: tokenData.allTokenLists,
      customTokens: tokenData.userAddedTokens,
      verifiedTokenIds: tokenData.verifiedTokenIds,
      tokenizedAssetProviderByTokenId: tokenData.tokenizedAssetProviderByTokenId,
      onBack: closeManageWidget,
    }
  }, [
    isManageWidgetOpen,
    tokenData.allTokenLists,
    tokenData.userAddedTokens,
    tokenData.verifiedTokenIds,
    tokenData.tokenizedAssetProviderByTokenId,
    closeManageWidget,
  ])
}
