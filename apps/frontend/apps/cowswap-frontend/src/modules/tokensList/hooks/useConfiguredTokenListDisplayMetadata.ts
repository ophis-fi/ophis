import { atom, type Atom, type WritableAtom, useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isSupportedChainId } from '@cowprotocol/common-utils'
import { getTokenId } from '@cowprotocol/cow-sdk'
import { DEFAULT_TOKENS_LISTS, fetchTokenList, ListSourceConfig, ListState, TokenListTags } from '@cowprotocol/tokens'
import { StatusColorVariant } from '@cowprotocol/ui'

import { atomWithQuery, type AtomWithQueryResult } from 'jotai-tanstack-query'

import { TokenizedAssetProviderTag } from '../types'

export interface ConfiguredTokenListDisplayMetadata {
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  tokenListTags: TokenListTags
}

const TOKENIZED_ASSET_PROVIDER_TAGS: readonly TokenizedAssetProviderTag[] = ['ondo', 'xStocks']
const CONFIGURED_LISTS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1_000
const ALL_CONFIGURED_TOKEN_LIST_SOURCES = new Set(
  Object.values(DEFAULT_TOKENS_LISTS).flatMap((lists) => lists?.map(({ source }) => source) ?? []),
)

function getConfiguredSources(targetChainId: number | undefined): ReadonlySet<string> {
  if (!targetChainId) return ALL_CONFIGURED_TOKEN_LIST_SOURCES
  if (!isSupportedChainId(targetChainId)) return new Set()

  return new Set(DEFAULT_TOKENS_LISTS[targetChainId]?.map(({ source }) => source) ?? [])
}

function getConfiguredLists(targetChainId: number | undefined): readonly ListSourceConfig[] {
  if (!targetChainId || !isSupportedChainId(targetChainId)) return []

  return DEFAULT_TOKENS_LISTS[targetChainId] ?? []
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

    for (const tag of TOKENIZED_ASSET_PROVIDER_TAGS) {
      const tagInfo = tokenList.list.tags?.[tag]
      if (!tagInfo) continue

      tokenListTags[tag] = {
        id: tag,
        name: tagInfo.name,
        description: tagInfo.description,
        color: StatusColorVariant.Info,
      }
    }

    for (const token of tokenList.list.tokens) {
      const tokenId = getTokenId({ chainId: token.chainId, address: token.address })
      tokenIds.add(tokenId)

      const providerTag = TOKENIZED_ASSET_PROVIDER_TAGS.find((tag) => token.tags?.includes(tag))
      if (providerTag) providerByTokenId.set(tokenId, providerTag)
    }
  }

  return { verifiedTokenIds: tokenIds, tokenizedAssetProviderByTokenId: providerByTokenId, tokenListTags }
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

export function createConfiguredTokenListsQueryAtom(targetChainId: number | undefined): Atom<ListState[]> {
  const configuredLists = getConfiguredLists(targetChainId)
  const queryAtoms = targetChainId
    ? configuredLists.map((configuredList) => getConfiguredTokenListQueryAtom(targetChainId, configuredList))
    : []

  return atom((get) => collectConfiguredTokenLists(queryAtoms.map((queryAtom) => get(queryAtom))))
}

export function useConfiguredTokenListDisplayMetadata(targetChainId?: number): ConfiguredTokenListDisplayMetadata {
  const configuredListsQueryAtom = useMemo(() => createConfiguredTokenListsQueryAtom(targetChainId), [targetChainId])
  const configuredLists = useAtomValue(configuredListsQueryAtom)

  return useMemo(
    () => getConfiguredTokenListDisplayMetadataForChain(configuredLists, targetChainId),
    [configuredLists, targetChainId],
  )
}
