import { ReactNode, useCallback, useEffect, useMemo } from 'react'

import { doesTokenMatchSymbolOrAddress } from '@cowprotocol/common-utils'
import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'
import { getTokenSearchFilter, TokenSearchResponse, useSearchToken } from '@cowprotocol/tokens'

import { Field } from 'legacy/state/types'

import { useInjectedWidgetParams } from 'modules/injectedWidget'

import { useAddTokenImportCallback } from '../../hooks/useAddTokenImportCallback'
import { useSelectTokenWidgetState } from '../../hooks/useSelectTokenWidgetState'
import { useTokenListContext } from '../../hooks/useTokenListContext'
import { useTokenListViewState } from '../../hooks/useTokenListViewState'
import { useUpdateSelectTokenWidgetState } from '../../hooks/useUpdateSelectTokenWidgetState'
import { CommonListContainer } from '../../pure/commonElements'
import { TokenSearchContent } from '../../pure/TokenSearchContent'

export function TokenSearchResults(): ReactNode {
  const { searchInput } = useTokenListViewState()

  const { selectTokenContext, areTokensFromBridge, allTokens, areTokensLoading, bridgeSupportedTokensMap } =
    useTokenListContext()
  const { tokenLists, sellTokenLists, buyTokenLists } = useInjectedWidgetParams()

  const { onTokenListItemClick } = selectTokenContext

  const { field, onSelectToken } = useSelectTokenWidgetState()

  // Bridge destinations must not query the wallet chain's token lists.
  const defaultSearchResults = useSearchToken(areTokensFromBridge ? null : searchInput)
  const filter = useMemo(() => getTokenSearchFilter(searchInput), [searchInput])
  const hasScopedListRestriction = useMemo(() => {
    if (field === Field.INPUT) {
      return !!(tokenLists?.length || sellTokenLists?.length)
    }

    if (field === Field.OUTPUT) {
      return !!(tokenLists?.length || buyTokenLists?.length)
    }

    return !!(tokenLists?.length || sellTokenLists?.length || buyTokenLists?.length)
  }, [buyTokenLists?.length, field, sellTokenLists?.length, tokenLists?.length])

  const searchResults: TokenSearchResponse = useMemo(() => {
    if (!hasScopedListRestriction && !areTokensFromBridge) {
      return defaultSearchResults
    }

    // A destination search uses only assets offered for this chain pair.
    return {
      isLoading: areTokensFromBridge ? areTokensLoading : defaultSearchResults.isLoading,
      activeListsResult: allTokens.filter(
        (token) => filter(token) || (areTokensFromBridge && areAddressesEqual(token.address, searchInput)),
      ),
      inactiveListsResult: [],
      blockchainResult: [],
      externalApiResult: [],
    }
  }, [
    allTokens,
    areTokensFromBridge,
    areTokensLoading,
    defaultSearchResults,
    filter,
    hasScopedListRestriction,
    searchInput,
  ])

  const { activeListsResult } = searchResults

  const updateSelectTokenWidget = useUpdateSelectTokenWidgetState()

  const addTokenImportCallback = useAddTokenImportCallback()

  const matchedTokens = useMemo(() => {
    return activeListsResult.filter((t) => doesTokenMatchSymbolOrAddress(t, searchInput))
  }, [activeListsResult, searchInput])

  // On press Enter, select first token if only one token is found or it fully matches to the search input
  const onInputPressEnter = useCallback(() => {
    if (!searchInput || !activeListsResult) return

    if (activeListsResult.length === 1 || matchedTokens.length === 1) {
      const tokenToSelect = matchedTokens[0] || activeListsResult[0]

      // In bridge mode, don't select non-bridgeable tokens (also block while map is loading)
      if (tokenToSelect) {
        const hasAddress = !!tokenToSelect.address
        const isInBridgeMap =
          hasAddress &&
          bridgeSupportedTokensMap !== null &&
          !!bridgeSupportedTokensMap[getAddressKey(tokenToSelect.address)]
        const isBridgeable = !areTokensFromBridge || isInBridgeMap

        if (isBridgeable) {
          onTokenListItemClick?.(tokenToSelect)
          onSelectToken?.(tokenToSelect)
        }
      }
    }
  }, [
    searchInput,
    activeListsResult,
    matchedTokens,
    onSelectToken,
    onTokenListItemClick,
    areTokensFromBridge,
    bridgeSupportedTokensMap,
  ])

  useEffect(() => {
    updateSelectTokenWidget({
      onInputPressEnter,
    })
  }, [onInputPressEnter, updateSelectTokenWidget])

  return (
    <CommonListContainer id="currency-list">
      <TokenSearchContent
        importToken={addTokenImportCallback}
        searchInput={searchInput}
        selectTokenContext={selectTokenContext}
        searchResults={searchResults}
        areTokensFromBridge={areTokensFromBridge}
        bridgeSupportedTokensMap={bridgeSupportedTokensMap}
      />
    </CommonListContainer>
  )
}
