import { atom, useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useMemo } from 'react'

import { atomWithQuery } from 'jotai-tanstack-query'

import { TOKENS_LISTS_UPDATER_INTERVAL } from './helpers'

import { fetchTokenList } from '../../services/fetchTokenList'
import { environmentAtom } from '../../state/environmentAtom'
import { upsertListsAtom } from '../../state/tokenLists/tokenListsActionsAtom'
import { allListsSourcesAtom, tokenListsUpdatingAtom } from '../../state/tokenLists/tokenListsStateAtom'

export function useTokenListsQuery(): void {
  const { chainId } = useAtomValue(environmentAtom)
  const sources = useAtomValue(allListsSourcesAtom)
  const upsertLists = useSetAtom(upsertListsAtom)
  const setUpdating = useSetAtom(tokenListsUpdatingAtom)
  const queriesAtom = useMemo(() => {
    const queries = sources.map((source) =>
      atomWithQuery(() => ({
        queryKey: ['token-list', chainId, source],
        queryFn: () => fetchTokenList(source),
        staleTime: TOKENS_LISTS_UPDATER_INTERVAL,
        refetchInterval: TOKENS_LISTS_UPDATER_INTERVAL,
        refetchOnWindowFocus: false,
        retry: 1,
      })),
    )
    return atom((get) => queries.map((query) => get(query)))
  }, [chainId, sources])
  const results = useAtomValue(queriesAtom)

  useEffect(() => {
    setUpdating(results.some((result) => result.isLoading))
    // Publish each healthy list immediately, even while another source is slow or unavailable.
    const lists = results.flatMap((result) => (result.data ? [result.data] : []))
    if (lists.length) void upsertLists(chainId, lists)
  }, [chainId, results, setUpdating, upsertLists])
}
