import { useMemo } from 'react'

import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import { OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'
import type { TokenInfo } from '@uniswap/token-lists'

import { useTokenListByUrl } from './useTokenListByUrl'

import { NATIVE_TOKEN_PER_NETWORK } from '../const'

type TokenListByAddress = Record<string, TokenInfo>
const COINGECKO_CHAINS: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'xdai',
  [SupportedChainId.BASE]: 'base',
  [SupportedChainId.ARBITRUM_ONE]: 'arbitrum-one',
  [SupportedChainId.SEPOLIA]: null,
  [SupportedChainId.POLYGON]: 'polygon-pos',
  [SupportedChainId.AVALANCHE]: 'avalanche',
  [SupportedChainId.BNB]: 'binance-smart-chain',
  [SupportedChainId.LINEA]: 'linea',
  [SupportedChainId.PLASMA]: 'plasma',
  [SupportedChainId.INK]: 'ink',
  // Ophis fork: OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: 'optimistic-ethereum',
  // Ophis fork: Unichain mainnet (chain 130) — CoinGecko 'unichain' platform slug
  [130 as unknown as SupportedChainId]: 'unichain',
  // CoinGecko Robinhood Chain platform slug.
  [4663 as unknown as SupportedChainId]: 'robinhood',
}

const EMPTY_TOKENS: TokenListByAddress = {}

export function useTokenList(chainId: SupportedChainId | undefined): { data: TokenListByAddress; isLoading: boolean } {
  const { data: ophisList, isLoading: isOphisListLoading } = useTokenListByUrl(chainId ? OPHIS_TOKENS_LIST_SOURCE : '')
  const { data: coingeckoUniswapList, isLoading: isCoingeckoUniswapLoading } = useTokenListByUrl(
    chainId === SupportedChainId.MAINNET ? 'https://tokens.coingecko.com/uniswap/all.json' : '',
  )
  const { data: honeyswapList, isLoading: isHoneyswapListLoading } = useTokenListByUrl(
    chainId === SupportedChainId.GNOSIS_CHAIN ? 'https://tokens.honeyswap.org' : '',
  )
  const coingeckoUrlKey = chainId && COINGECKO_CHAINS[chainId]
  const { data: coingeckoList, isLoading: isCoingeckoLoading } = useTokenListByUrl(
    coingeckoUrlKey ? `https://tokens.coingecko.com/${coingeckoUrlKey}/all.json` : '',
  )

  const isLoading = chainId
    ? isOphisListLoading || isHoneyswapListLoading || isCoingeckoUniswapLoading || isCoingeckoLoading
    : false

  return useMemo(() => {
    if (!chainId) return { data: EMPTY_TOKENS, isLoading: false }

    // Merge tokens, not whole chain maps; Ophis metadata wins over supplements.
    const data: TokenListByAddress = {}
    for (const list of [coingeckoUniswapList, honeyswapList, coingeckoList, ophisList]) {
      for (const token of list ?? []) {
        if (token.chainId === chainId) data[getAddressKey(token.address)] = token
      }
    }

    // Non-EVM bridge destinations (Solana, Bitcoin) have no entry here; a
    // cross-chain order to them must not take the whole order page down.
    const nativeToken = NATIVE_TOKEN_PER_NETWORK[chainId]

    if (nativeToken) {
      data[getAddressKey(nativeToken.address)] = {
        ...nativeToken,
        name: nativeToken.name || '',
        symbol: nativeToken.symbol || '',
        chainId,
      }
    }

    return { data, isLoading }
  }, [chainId, coingeckoUniswapList, honeyswapList, ophisList, coingeckoList, isLoading])
}
