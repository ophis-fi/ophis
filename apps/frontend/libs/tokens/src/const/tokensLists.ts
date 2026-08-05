import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

import lpTokensList from './lpTokensList.json'
import tokensList from './tokensList.json'

import { ListSourceConfig, ListsSourcesByNetwork } from '../types'

export const LP_TOKEN_LISTS = lpTokensList as Array<ListSourceConfig>

// Ophis: tokensList.json has explicit entries for the Ophis-operated and
// sovereign chains, but `mapSupportedNetworks` only
// iterates SDK's SupportedChainId.
// Manually inject those entries after the SDK map so curated-mode users on
// those chains get a working token list rather than undefined.
const _baseTokensLists = mapSupportedNetworks((chainId) => tokensList[chainId])
export const DEFAULT_TOKENS_LISTS: ListsSourcesByNetwork = {
  ..._baseTokensLists,
  [10 as unknown as SupportedChainId]: tokensList['10' as unknown as keyof typeof tokensList],
  [130 as unknown as SupportedChainId]: tokensList['130' as unknown as keyof typeof tokensList],
  [4663 as unknown as SupportedChainId]: tokensList['4663' as unknown as keyof typeof tokensList],
}

export const UNISWAP_TOKENS_LIST = 'https://ipfs.io/ipns/tokens.uniswap.org'

export const ONDO_TOKENS_LIST_SOURCE = tokensList[SupportedChainId.MAINNET][3].source

export const XSTOCKS_TOKENS_LIST_SOURCE = tokensList[SupportedChainId.MAINNET][4].source

export const RWA_TOKENS_LIST_SOURCES = [ONDO_TOKENS_LIST_SOURCE, XSTOCKS_TOKENS_LIST_SOURCE] as const
