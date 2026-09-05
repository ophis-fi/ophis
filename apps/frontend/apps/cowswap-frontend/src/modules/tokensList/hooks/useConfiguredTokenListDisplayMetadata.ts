import { atom, type Atom, type WritableAtom, useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isSupportedChainId } from '@cowprotocol/common-utils'
import { getTokenId } from '@cowprotocol/cow-sdk'
import {
  COINBASE_TOKENIZED_STOCKS_LIST_SOURCE,
  DEFAULT_TOKENS_LISTS,
  fetchTokenList,
  listsStatesByChainAtom,
  ListSourceConfig,
  ListState,
  ONDO_TOKENS_LIST_SOURCE,
  TokenListTags,
  XSTOCKS_TOKENS_LIST_SOURCE,
} from '@cowprotocol/tokens'
import { StatusColorVariant } from '@cowprotocol/ui'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'

import { TokenizedAssetProviderTag } from '../types'

export interface ConfiguredTokenListDisplayMetadata {
  listedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  tokenListTags: TokenListTags
}

const CONFIGURED_LISTS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000
const EMPTY_CONFIGURED_LISTS: readonly ListSourceConfig[] = []
const EMPTY_PERSISTED_LISTS: Readonly<Record<string, ListState | 'deleted' | undefined>> = {}
const TOKENIZED_ASSET_PROVIDER_BY_SOURCE = new Map<string, TokenizedAssetProviderTag>([
  [ONDO_TOKENS_LIST_SOURCE, 'ondo'],
  [XSTOCKS_TOKENS_LIST_SOURCE, 'xStocks'],
  [COINBASE_TOKENIZED_STOCKS_LIST_SOURCE, 'coinbase'],
])
const ALL_CONFIGURED_TOKEN_LIST_SOURCES = new Set(
  Object.values(DEFAULT_TOKENS_LISTS).flatMap((lists) => lists?.map(({ source }) => source) ?? []),
)

function getConfiguredSources(targetChainId: number | undefined): ReadonlySet<string> {
  if (!targetChainId) return ALL_CONFIGURED_TOKEN_LIST_SOURCES
  if (!isSupportedChainId(targetChainId)) return new Set()

  return new Set(DEFAULT_TOKENS_LISTS[targetChainId]?.map(({ source }) => source) ?? [])
}

function getConfiguredLists(targetChainId: number | undefined): readonly ListSourceConfig[] {
  if (!targetChainId || !isSupportedChainId(targetChainId)) return EMPTY_CONFIGURED_LISTS

  return DEFAULT_TOKENS_LISTS[targetChainId] ?? []
}

function addProviderTagInfo(
  tokenList: ListState,
  providerTag: TokenizedAssetProviderTag | undefined,
  tokenListTags: TokenListTags,
): void {
  if (!providerTag) return

  const providerTagInfo = tokenList.list.tags?.[providerTag]
  if (!providerTagInfo) return

  tokenListTags[providerTag] = {
    id: providerTag,
    name: providerTagInfo.name,
    description: providerTagInfo.description,
    color: StatusColorVariant.Info,
  }
}

function addTokenMetadata(
  tokenList: ListState,
  providerTag: TokenizedAssetProviderTag | undefined,
  tokenIds: Set<string>,
  providerByTokenId: Map<string, TokenizedAssetProviderTag>,
): void {
  for (const token of tokenList.list.tokens) {
    const tokenId = getTokenId({ chainId: token.chainId, address: token.address })
    tokenIds.add(tokenId)

    if (providerTag && token.tags?.includes(providerTag)) providerByTokenId.set(tokenId, providerTag)
  }
}

export function getConfiguredTokenListDisplayMetadata(
  tokenLists: readonly ListState[],
  configuredSources: ReadonlySet<string> = ALL_CONFIGURED_TOKEN_LIST_SOURCES,
): ConfiguredTokenListDisplayMetadata {
  const tokenIds = new Set<string>()
  const providerByTokenId = new Map<string, TokenizedAssetProviderTag>()
  const tokenListTags: TokenListTags = {}

  for (const tokenList of tokenLists) {
    if (!configuredSources.has(tokenList.source)) continue

    const providerTag = TOKENIZED_ASSET_PROVIDER_BY_SOURCE.get(tokenList.source)
    addProviderTagInfo(tokenList, providerTag, tokenListTags)
    addTokenMetadata(tokenList, providerTag, tokenIds, providerByTokenId)
  }

  return { listedTokenIds: tokenIds, tokenizedAssetProviderByTokenId: providerByTokenId, tokenListTags }
}

export function getConfiguredTokenListDisplayMetadataForChain(
  tokenLists: readonly ListState[],
  targetChainId: number | undefined,
): ConfiguredTokenListDisplayMetadata {
  return getConfiguredTokenListDisplayMetadata(tokenLists, getConfiguredSources(targetChainId))
}

type ConfiguredTokenListQueryAtom = WritableAtom<AtomWithQueryResult<ListState, Error>, [], void>

interface ConfiguredTokenListQueryOptions {
  queryKey: readonly ['configured-token-list-display-metadata', number, string]
  queryFn: () => Promise<ListState>
  staleTime: number
  refetchInterval: number
  refetchOnWindowFocus: true
}

const configuredTokenListQueryAtoms = new Map<string, ConfiguredTokenListQueryAtom>()

export function getConfiguredTokenListQueryOptions(
  targetChainId: number,
  configuredList: ListSourceConfig,
  loadTokenList: typeof fetchTokenList = fetchTokenList,
): ConfiguredTokenListQueryOptions {
  return {
    queryKey: ['configured-token-list-display-metadata', targetChainId, configuredList.source],
    queryFn: () => loadTokenList(configuredList),
    staleTime: CONFIGURED_LISTS_REFRESH_INTERVAL_MS,
    refetchInterval: CONFIGURED_LISTS_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  }
}

function getConfiguredTokenListQueryAtom(
  targetChainId: number,
  configuredList: ListSourceConfig,
): ConfiguredTokenListQueryAtom {
  const cacheKey = `${targetChainId}:${configuredList.source}`
  const cachedAtom = configuredTokenListQueryAtoms.get(cacheKey)

  if (cachedAtom) return cachedAtom

  const queryAtom = atomWithQuery(() => getConfiguredTokenListQueryOptions(targetChainId, configuredList))
  configuredTokenListQueryAtoms.set(cacheKey, queryAtom)

  return queryAtom
}

export function collectConfiguredTokenLists(results: readonly { data?: ListState }[]): ListState[] {
  return results.flatMap(({ data }) => (data ? [data] : []))
}

export function mergeConfiguredTokenListsWithPersistedFallback(
  queriedLists: readonly ListState[],
  persistedLists: Readonly<Record<string, ListState | 'deleted' | undefined>>,
  configuredLists: readonly ListSourceConfig[],
): ListState[] {
  const queriedListsBySource = new Map(queriedLists.map((list) => [list.source, list]))

  return configuredLists.flatMap((configuredList) => {
    const queriedList = queriedListsBySource.get(configuredList.source)
    if (queriedList) return [queriedList]

    const persistedList = persistedLists[configuredList.source]
    return persistedList !== 'deleted' && persistedList?.source === configuredList.source ? [persistedList] : []
  })
}

export function createConfiguredTokenListsQueryAtom(targetChainId: number | undefined): Atom<ListState[]> {
  const configuredLists = getConfiguredLists(targetChainId)
  const queryAtoms = targetChainId
    ? configuredLists.map((configuredList) => getConfiguredTokenListQueryAtom(targetChainId, configuredList))
    : []

  return atom((get) => collectConfiguredTokenLists(queryAtoms.map((queryAtom) => get(queryAtom))))
}

export function useConfiguredTokenListDisplayMetadata(targetChainId?: number): ConfiguredTokenListDisplayMetadata {
  const configuredListsQueryAtom = useMemo(() => createConfiguredTokenListsQueryAtom(targetChainId), [targetChainId])
  const queriedLists = useAtomValue(configuredListsQueryAtom)
  const listsStatesByChain = useAtomValue(listsStatesByChainAtom)
  const configuredLists = getConfiguredLists(targetChainId)
  const persistedLists =
    targetChainId && isSupportedChainId(targetChainId)
      ? (listsStatesByChain[targetChainId] ?? EMPTY_PERSISTED_LISTS)
      : EMPTY_PERSISTED_LISTS
  const availableLists = useMemo(
    () => mergeConfiguredTokenListsWithPersistedFallback(queriedLists, persistedLists, configuredLists),
    [queriedLists, persistedLists, configuredLists],
  )

  return useMemo(
    () => getConfiguredTokenListDisplayMetadataForChain(availableLists, targetChainId),
    [availableLists, targetChainId],
  )
}
