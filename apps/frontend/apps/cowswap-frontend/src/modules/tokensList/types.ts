import { BalancesState } from '@cowprotocol/balances-and-allowances'
import { TokenWithLogo } from '@cowprotocol/common-const'
import { ChainInfo } from '@cowprotocol/cow-sdk'
import type { TokenListTags } from '@cowprotocol/tokens'

import { PermitCompatibleTokens } from 'modules/permit'

export type TokenSelectionHandler = (token: TokenWithLogo) => Promise<void> | void
export const TOKENIZED_ASSET_PROVIDER_TAGS = ['ondo', 'xStocks', 'coinbase'] as const
export type TokenizedAssetProviderTag = (typeof TOKENIZED_ASSET_PROVIDER_TAGS)[number]

export interface SelectTokenContext {
  balancesState: BalancesState
  onTokenListItemClick?(token: TokenWithLogo): void
  unsupportedTokens: { [tokenAddress: string]: { dateAdded: number } }
  permitCompatibleTokens: PermitCompatibleTokens
  tokenListTags: TokenListTags
  listedTokenIds: ReadonlySet<string>
  tokenizedAssetProviderByTokenId: ReadonlyMap<string, TokenizedAssetProviderTag>
  isWalletConnected: boolean
}

export interface ChainsToSelectState {
  chains: ChainInfo[] | undefined
  defaultChainId?: number
  isLoading?: boolean
  disabledChainIds?: Set<number>
  loadingChainIds?: Set<number>
}
