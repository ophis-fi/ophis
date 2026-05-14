import { mapSupportedNetworks, SupportedChainId } from '@cowprotocol/cow-sdk'

import lpTokensList from './lpTokensList.json'
import tokensList from './tokensList.json'

import { ListSourceConfig, ListsSourcesByNetwork } from '../types'

export const LP_TOKEN_LISTS = lpTokensList as Array<ListSourceConfig>

// Ophis: tokensList.json has a "10" key for OP mainnet, but
// `mapSupportedNetworks` only iterates SDK's SupportedChainId (no OP).
// Codex review 2026-05-14 flagged the "10" JSON entry as dead code.
// Manually inject the OP entry after the SDK map so curated-mode users
// on OP get the canonical Optimism + CoinGecko lists rather than undefined.
const _baseTokensLists = mapSupportedNetworks((chainId) => tokensList[chainId])
export const DEFAULT_TOKENS_LISTS: ListsSourcesByNetwork = {
  ..._baseTokensLists,
  [10 as unknown as SupportedChainId]: tokensList['10' as unknown as keyof typeof tokensList],
}

export const UNISWAP_TOKENS_LIST = 'https://ipfs.io/ipns/tokens.uniswap.org'

export const ONDO_TOKENS_LIST_SOURCE = tokensList[SupportedChainId.MAINNET][3].source

export const XSTOCKS_TOKENS_LIST_SOURCE = tokensList[SupportedChainId.MAINNET][4].source

export const RWA_TOKENS_LIST_SOURCES = [ONDO_TOKENS_LIST_SOURCE, XSTOCKS_TOKENS_LIST_SOURCE] as const
