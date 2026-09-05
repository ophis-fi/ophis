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

// Ophis: Coinbase's tokenized stocks on Base (B20). Served from our own origin (next to
// /api/pons-token-list) and registered for Base at priority 0 in tokensList.json so the
// on-chain symbol (AAPLc) and the issuer logo win over CoinGecko's AAPLC entry. Keyed by
// URL, not by array position, so reordering the Base lists cannot silently repoint it.
// Deliberately NOT part of RWA_TOKENS_LIST_SOURCES: B20 stocks trade 24/7 on DEXs, so the
// weekend-closed and minimum-size rules for Ondo/xStocks do not apply.
export const COINBASE_TOKENIZED_STOCKS_LIST_SOURCE = 'https://swap.ophis.fi/token-lists/coinbase-tokenized-stocks.json'
