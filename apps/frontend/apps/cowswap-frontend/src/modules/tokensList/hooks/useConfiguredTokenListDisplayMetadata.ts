import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isSupportedChainId } from '@cowprotocol/common-utils'
import { getTokenId } from '@cowprotocol/cow-sdk'
import {
  DEFAULT_TOKENS_LISTS,
  fetchTokenList,
  ListSourceConfig,
  ListState,
  listsStatesByChainAtom,
  TokenListTags,
  TokenListsByChainState,
  useAllListsList,
} from '@cowprotocol/tokens'
import { StatusColorVariant } from '@cowprotocol/ui'

import useSWR from 'swr'

import { TokenizedAssetProviderTag } from '../types'

export interface ConfiguredTokenListDisplayMetadata {
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  tokenListTags: TokenListTags
}

const TOKENIZED_ASSET_PROVIDER_TAGS: readonly TokenizedAssetProviderTag[] = ['ondo', 'xStocks']
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

function getLoadedTargetChainLists(
  listsStatesByChain: TokenListsByChainState,
  targetChainId: number | undefined,
): ListState[] {
  if (!targetChainId || !isSupportedChainId(targetChainId)) return []

  return Object.values(listsStatesByChain[targetChainId] ?? {}).filter(
    (listState): listState is ListState => listState !== 'deleted',
  )
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
  currentChainLists: readonly ListState[],
  listsStatesByChain: TokenListsByChainState,
  targetChainId: number | undefined,
  fetchedTargetChainLists: readonly ListState[] = [],
): ConfiguredTokenListDisplayMetadata {
  const targetChainLists = getLoadedTargetChainLists(listsStatesByChain, targetChainId)

  return getConfiguredTokenListDisplayMetadata(
    [...currentChainLists, ...targetChainLists, ...fetchedTargetChainLists],
    getConfiguredSources(targetChainId),
  )
}

export function getMissingConfiguredTokenLists(
  currentChainLists: readonly ListState[],
  listsStatesByChain: TokenListsByChainState,
  targetChainId: number | undefined,
): readonly ListSourceConfig[] {
  const loadedSources = new Set([
    ...currentChainLists.map(({ source }) => source),
    ...getLoadedTargetChainLists(listsStatesByChain, targetChainId).map(({ source }) => source),
  ])

  return getConfiguredLists(targetChainId).filter(({ source }) => !loadedSources.has(source))
}

export function useConfiguredTokenListDisplayMetadata(targetChainId?: number): ConfiguredTokenListDisplayMetadata {
  const currentChainLists = useAllListsList()
  const listsStatesByChain = useAtomValue(listsStatesByChainAtom)
  const missingTargetLists = useMemo(
    () => getMissingConfiguredTokenLists(currentChainLists, listsStatesByChain, targetChainId),
    [currentChainLists, listsStatesByChain, targetChainId],
  )
  const missingTargetListSources = useMemo(
    () => missingTargetLists.map(({ source }) => source).sort(),
    [missingTargetLists],
  )
  const { data: fetchedTargetChainLists = [] } = useSWR<ListState[]>(
    missingTargetLists.length ? ['ConfiguredTokenListDisplayMetadata', targetChainId, missingTargetListSources] : null,
    async () => {
      const results = await Promise.allSettled(missingTargetLists.map(fetchTokenList))
      return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    },
    { revalidateOnFocus: false },
  )

  return useMemo(
    () =>
      getConfiguredTokenListDisplayMetadataForChain(
        currentChainLists,
        listsStatesByChain,
        targetChainId,
        fetchedTargetChainLists,
      ),
    [currentChainLists, listsStatesByChain, targetChainId, fetchedTargetChainLists],
  )
}
