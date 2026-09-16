import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { getRpcProvider, TokenWithLogo } from '@cowprotocol/common-const'
import { useDebounce } from '@cowprotocol/common-hooks'
import { isAddress } from '@cowprotocol/common-utils'
import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { atomWithQuery } from 'jotai-tanstack-query'
import ms from 'ms.macro'

import { environmentAtom } from '../../state/environmentAtom'
import { allActiveTokensAtom, inactiveTokensAtom } from '../../state/tokens/allTokensAtom'
import { fetchTokenFromBlockchain } from '../../utils/fetchTokenFromBlockchain'
import { getTokenSearchFilter } from '../../utils/getTokenSearchFilter'

const IN_LISTS_DEBOUNCE_TIME = ms`50ms`
const IN_EXTERNALS_DEBOUNCE_TIME = ms`1s`

export type TokenSearchResponse = {
  isLoading: boolean
  blockchainResult: TokenWithLogo[]
  externalApiResult: TokenWithLogo[]
  activeListsResult: TokenWithLogo[]
  inactiveListsResult: TokenWithLogo[]
}

const emptyResponse: TokenSearchResponse = {
  isLoading: false,
  blockchainResult: [],
  externalApiResult: [],
  activeListsResult: [],
  inactiveListsResult: [],
}

export function useSearchToken(input: string | null): TokenSearchResponse {
  const normalizedInput = input?.trim().toLowerCase()
  const listInput = useDebounce(normalizedInput, IN_LISTS_DEBOUNCE_TIME)
  const blockchainInput = useDebounce(normalizedInput, IN_EXTERNALS_DEBOUNCE_TIME)
  const { chainId } = useAtomValue(environmentAtom)
  const activeTokens = useAtomValue(allActiveTokensAtom).tokens
  const inactiveTokens = useAtomValue(inactiveTokensAtom)
  const lists = useMemo(() => {
    if (!listInput) return emptyResponse
    const filter = getTokenSearchFilter(listInput)
    return {
      activeListsResult: activeTokens.filter(filter),
      inactiveListsResult: inactiveTokens.filter(filter),
    }
  }, [listInput, activeTokens, inactiveTokens])
  const foundByAddress = [...lists.activeListsResult, ...lists.inactiveListsResult].some(
    (token) => !!blockchainInput && areAddressesEqual(token.address, blockchainInput),
  )
  const queryAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        // Metadata belongs to the picker network, regardless of the wallet's network.
        queryKey: ['fetchTokenFromBlockchain', chainId, blockchainInput],
        enabled: !!blockchainInput && !!isAddress(blockchainInput) && !foundByAddress,
        queryFn: async () => {
          if (!blockchainInput || !isAddress(blockchainInput)) return null
          const provider = getRpcProvider(chainId)
          if (!provider) return null
          return TokenWithLogo.fromToken(await fetchTokenFromBlockchain(blockchainInput, chainId, provider))
        },
        staleTime: ms`1m`,
        refetchOnWindowFocus: false,
        retry: 1,
      })),
    [chainId, blockchainInput, foundByAddress],
  )
  const blockchain = useAtomValue(queryAtom)
  const isStale = blockchainInput !== normalizedInput

  return useMemo(() => {
    if (!normalizedInput || listInput !== normalizedInput) {
      return { ...emptyResponse, isLoading: !!normalizedInput }
    }
    const hasListResults = !!(lists.activeListsResult.length || lists.inactiveListsResult.length)
    return {
      ...emptyResponse,
      ...lists,
      isLoading: !hasListResults && (isStale || blockchain.isLoading),
      blockchainResult: !foundByAddress && !isStale && blockchain.data ? [blockchain.data] : [],
    }
  }, [normalizedInput, listInput, lists, isStale, foundByAddress, blockchain.isLoading, blockchain.data])
}
