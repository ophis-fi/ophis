import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { ListState, TokenListTags } from '@cowprotocol/tokens'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useManageWidgetVisibility } from './useManageWidgetVisibility'
import { useTokenDataSources } from './useTokenDataSources'

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
  // Manage's list and address-search hooks are scoped to the wallet environment chain.
  const { chainId } = useWalletInfo()
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
