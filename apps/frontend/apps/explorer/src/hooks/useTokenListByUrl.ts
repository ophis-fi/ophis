import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { fetchTokenList } from '@cowprotocol/tokens'
import type { TokenInfo } from '@uniswap/token-lists'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'

export function useTokenListByUrl(tokenListUrl: string): AtomWithQueryResult<TokenInfo[], Error> {
  const queryAtom = useMemo(
    () =>
      atomWithQuery<TokenInfo[], Error>(() => ({
        queryKey: ['explorerTokenList', tokenListUrl],
        enabled: !!tokenListUrl,
        queryFn: async (): Promise<TokenInfo[]> => {
          const state = await fetchTokenList({ source: tokenListUrl, priority: 1 })
          return state.list?.tokens ?? []
        },
        staleTime: 300_000,
        refetchOnWindowFocus: false,
      })),
    [tokenListUrl],
  )
  return useAtomValue(queryAtom)
}
