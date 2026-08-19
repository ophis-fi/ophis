import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { useWalletInfo } from '@cowprotocol/wallet'

import { useChainsToSelect } from './useChainsToSelect'
import { useSelectTokenWidgetState } from './useSelectTokenWidgetState'

import { useTokenDataSources } from '../containers/SelectTokenWidget/hooks/useTokenDataSources'
import { useTokenSelectionHandler } from '../containers/SelectTokenWidget/hooks/useTokenSelectionHandler'
import { SelectTokenContext } from '../types'

interface UseSelectTokenContextParams {
  onTokenListItemClick?: (token: TokenWithLogo) => void
}

export function useSelectTokenContext(params?: UseSelectTokenContextParams): SelectTokenContext {
  const { account, chainId } = useWalletInfo()
  const widgetState = useSelectTokenWidgetState()
  const chainsToSelect = useChainsToSelect()
  const targetChainId = chainsToSelect?.defaultChainId ?? widgetState.selectedTargetChainId ?? chainId
  const tokenData = useTokenDataSources(targetChainId)

  const handleSelectToken = useTokenSelectionHandler(widgetState.onSelectToken, widgetState)

  return useMemo(
    () => ({
      balancesState: tokenData.balancesState,
      selectedToken: widgetState.selectedToken,
      onSelectToken: handleSelectToken,
      onTokenListItemClick: params?.onTokenListItemClick,
      unsupportedTokens: tokenData.unsupportedTokens,
      permitCompatibleTokens: tokenData.permitCompatibleTokens,
      tokenListTags: tokenData.tokenListTags,
      listedTokenIds: tokenData.listedTokenIds,
      tokenizedAssetProviderByTokenId: tokenData.tokenizedAssetProviderByTokenId,
      isWalletConnected: !!account,
    }),
    [
      tokenData.balancesState,
      widgetState.selectedToken,
      handleSelectToken,
      params?.onTokenListItemClick,
      tokenData.unsupportedTokens,
      tokenData.permitCompatibleTokens,
      tokenData.tokenListTags,
      tokenData.listedTokenIds,
      tokenData.tokenizedAssetProviderByTokenId,
      account,
    ],
  )
}
