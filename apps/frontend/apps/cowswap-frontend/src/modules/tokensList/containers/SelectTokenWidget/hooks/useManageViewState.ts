import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { environmentAtom, ListState, TokenListTags } from '@cowprotocol/tokens'

import { useManageWidgetVisibility } from './useManageWidgetVisibility'
import { useTokenDataSources } from './useTokenDataSources'

import { TokenizedAssetProviderTag } from '../../../types'

export interface ManageViewState {
  lists: ListState[]
  customTokens: TokenWithLogo[]
  listedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  tokenListTags: TokenListTags
  onBack: () => void
}

export function useManageViewState(): ManageViewState | null {
  const { isManageWidgetOpen, closeManageWidget } = useManageWidgetVisibility()
  // Keep display metadata on the exact token-module environment used by
  // useAllListsList/useUserAddedTokens/useSearchToken, including bridge targets.
  const { chainId } = useAtomValue(environmentAtom)
  const tokenData = useTokenDataSources(chainId)

  return useMemo(() => {
    if (!isManageWidgetOpen) return null

    return {
      lists: tokenData.allTokenLists,
      customTokens: tokenData.userAddedTokens,
      listedTokenIds: tokenData.listedTokenIds,
      tokenizedAssetProviderByTokenId: tokenData.tokenizedAssetProviderByTokenId,
      tokenListTags: tokenData.tokenListTags,
      onBack: closeManageWidget,
    }
  }, [
    isManageWidgetOpen,
    tokenData.allTokenLists,
    tokenData.userAddedTokens,
    tokenData.listedTokenIds,
    tokenData.tokenizedAssetProviderByTokenId,
    tokenData.tokenListTags,
    closeManageWidget,
  ])
}
