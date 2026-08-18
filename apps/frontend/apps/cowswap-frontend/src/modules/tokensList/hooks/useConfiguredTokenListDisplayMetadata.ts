import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isSupportedChainId } from '@cowprotocol/common-utils'
import { getTokenId } from '@cowprotocol/cow-sdk'
import {
  DEFAULT_TOKENS_LISTS,
  ListState,
  listsStatesByChainAtom,
  TokenListsByChainState,
  useAllListsList,
} from '@cowprotocol/tokens'

import { TokenizedAssetProviderTag } from '../types'

export interface ConfiguredTokenListDisplayMetadata {
  verifiedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
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

  for (const tokenList of tokenLists) {
    if (!configuredSources.has(tokenList.source)) continue

    for (const token of tokenList.list.tokens) {
      const tokenId = getTokenId({ chainId: token.chainId, address: token.address })
      tokenIds.add(tokenId)

      const providerTag = TOKENIZED_ASSET_PROVIDER_TAGS.find((tag) => token.tags?.includes(tag))
      if (providerTag) providerByTokenId.set(tokenId, providerTag)
    }
  }

  return { verifiedTokenIds: tokenIds, tokenizedAssetProviderByTokenId: providerByTokenId }
}

export function getConfiguredTokenListDisplayMetadataForChain(
  currentChainLists: readonly ListState[],
  listsStatesByChain: TokenListsByChainState,
  targetChainId: number | undefined,
): ConfiguredTokenListDisplayMetadata {
  const targetChainLists = getLoadedTargetChainLists(listsStatesByChain, targetChainId)

  return getConfiguredTokenListDisplayMetadata(
    [...currentChainLists, ...targetChainLists],
    getConfiguredSources(targetChainId),
  )
}

export function useConfiguredTokenListDisplayMetadata(
  targetChainId?: number,
): ConfiguredTokenListDisplayMetadata {
  const currentChainLists = useAllListsList()
  const listsStatesByChain = useAtomValue(listsStatesByChainAtom)

  return useMemo(
    () => getConfiguredTokenListDisplayMetadataForChain(currentChainLists, listsStatesByChain, targetChainId),
    [currentChainLists, listsStatesByChain, targetChainId],
  )
}
