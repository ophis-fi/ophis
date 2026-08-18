import { type WritableAtom, useAtomValue } from 'jotai'
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

type ConfiguredTokenListsQueryAtom = WritableAtom<AtomWithQueryResult<ListState[], Error>, [], void>

interface ConfiguredTokenListsQueryOptions {
  queryKey: readonly ['configured-token-list-display-metadata', number, readonly string[]]
  enabled: boolean
  queryFn: () => Promise<ListState[]>
  staleTime: number
  refetchInterval: number
  refetchOnWindowFocus: true
}

export function fetchConfiguredTokenLists(
  configuredLists: readonly ListSourceConfig[],
  loadTokenList: typeof fetchTokenList = fetchTokenList,
): Promise<ListState[]> {
  return Promise.all(configuredLists.map(loadTokenList))
}

export function getConfiguredTokenListsQueryOptions(
  targetChainId: number | undefined,
): ConfiguredTokenListsQueryOptions {
  const configuredLists = getConfiguredLists(targetChainId)
  const configuredSources = configuredLists.map(({ source }) => source).sort()

  return {
    queryKey: ['configured-token-list-display-metadata', targetChainId ?? 0, configuredSources],
    enabled: configuredLists.length > 0,
    queryFn: () => fetchConfiguredTokenLists(configuredLists),
    staleTime: CONFIGURED_LISTS_REFRESH_INTERVAL_MS,
    refetchInterval: CONFIGURED_LISTS_REFRESH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  }
}

export function createConfiguredTokenListsQueryAtom(targetChainId: number | undefined): ConfiguredTokenListsQueryAtom {
  return atomWithQuery(() => getConfiguredTokenListsQueryOptions(targetChainId))
}

export function useConfiguredTokenListDisplayMetadata(targetChainId?: number): ConfiguredTokenListDisplayMetadata {
  const configuredListsQueryAtom = useMemo(() => createConfiguredTokenListsQueryAtom(targetChainId), [targetChainId])
  const { data: configuredLists = [] } = useAtomValue(configuredListsQueryAtom)

  return useMemo(
    () => getConfiguredTokenListDisplayMetadataForChain(configuredLists, targetChainId),
    [configuredLists, targetChainId],
  )
}
