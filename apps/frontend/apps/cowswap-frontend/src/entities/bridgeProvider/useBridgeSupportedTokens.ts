import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { TokenWithLogo } from '@cowprotocol/common-const'
import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import { BuyTokensParams } from '@cowprotocol/sdk-bridging'
import { useTokensByAddressMapForChain } from '@cowprotocol/tokens'

import { arcOutboundBuyTokens, cctpBuyTokens, useIsCctpEnabled } from 'entities/cctp'
import { atomWithQuery } from 'jotai-tanstack-query'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'

import { isDeprecatedBridgeToken } from './deprecatedBridgeToken'
import { useBridgeProvidersIds } from './useBridgeProvidersIds'

export type BridgeSupportedToken = { tokens: TokenWithLogo[]; isRouteAvailable: boolean }

export function useBridgeSupportedTokens(params: BuyTokensParams | undefined): {
  data: BridgeSupportedToken | undefined
  isLoading: boolean
} {
  const isBridgingEnabled = useIsBridgingEnabled()
  const cctpEnabled = useIsCctpEnabled()
  const providerIds = useBridgeProvidersIds()
  const key = providerIds.join('|')

  // Get token map from token lists for the destination chain to fallback for missing logos
  const tokensByAddress = useTokensByAddressMapForChain(params?.buyChainId as SupportedChainId | undefined)
  const { sellChainId, buyChainId, sellTokenAddress } = params ?? {}
  const tokenListSize = Object.keys(tokensByAddress).length

  const cctpTokens = useMemo(
    () =>
      (isBridgingEnabled && cctpEnabled ? [...cctpBuyTokens(params), ...arcOutboundBuyTokens(params)] : []).map(
        (token) => {
          const listed = tokensByAddress[getAddressKey(token.address)]
          return TokenWithLogo.fromToken(
            { ...token, name: listed?.name || token.name || '', symbol: token.symbol || '' },
            listed?.logoURI,
          )
        },
      ),
    [params, tokensByAddress, isBridgingEnabled, cctpEnabled],
  )
  const queryAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['bridgeBuyTokens', sellChainId, buyChainId, sellTokenAddress, key, tokenListSize],
        enabled: isBridgingEnabled && buyChainId !== undefined,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        queryFn: async () => {
          if (buyChainId === undefined) return null
          try {
            return await bridgingSdk.getBuyTokens({ sellChainId, buyChainId, sellTokenAddress })
          } catch (error) {
            console.warn('[bridgeTokens] Failed to fetch buy tokens', error)
            return { isRouteAvailable: false, tokens: [] }
          }
        },
      })),
    [isBridgingEnabled, sellChainId, buyChainId, sellTokenAddress, key, tokenListSize],
  )
  const query = useAtomValue(queryAtom)
  const result = isBridgingEnabled ? query.data : undefined
  const data = useMemo(() => {
    if (!result && !cctpTokens.length) return undefined
    const tokens = (result?.tokens ?? []).reduce<TokenWithLogo[]>((acc, token) => {
      if (!token || token.chainId === undefined || !token.address) {
        console.warn('[bridgeTokens] Ignoring malformed token', token)
        return acc
      }

      // Hide aggregator-deprecated duplicates (NEAR Intents tags superseded
      // routes with a "(DEPRECATED)" symbol, e.g. "XPL_(DEPRECATED)"); the
      // current asset is always present alongside. See deprecatedBridgeToken.ts.
      if (isDeprecatedBridgeToken(token)) {
        return acc
      }

      // Fallback to token list logo if bridge doesn't provide one
      const listToken = tokensByAddress[getAddressKey(token.address)]
      const logoUrl = listToken?.logoURI || token.logoUrl

      acc.push(
        TokenWithLogo.fromToken(
          {
            ...token,
            name: token.name || '',
            symbol: token.symbol || '',
          },
          logoUrl,
        ),
      )

      return acc
    }, [])
    const tokensById = new Map([...tokens, ...cctpTokens].map((token) => [getAddressKey(token.address), token]))
    return {
      tokens: [...tokensById.values()],
      isRouteAvailable: cctpTokens.length > 0 || (!!result?.isRouteAvailable && tokens.length > 0),
    }
  }, [result, cctpTokens, tokensByAddress])
  return useMemo(
    () => ({ data, isLoading: isBridgingEnabled && query.isLoading }),
    [data, isBridgingEnabled, query.isLoading],
  )
}
