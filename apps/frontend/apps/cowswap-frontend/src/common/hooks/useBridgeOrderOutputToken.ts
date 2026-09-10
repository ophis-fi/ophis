import { useMemo } from 'react'

import { NATIVE_CURRENCIES, TokenWithLogo, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import type { CrossChainOrder } from '@cowprotocol/sdk-bridging'
import { useTokensByAddressMapForChain } from '@cowprotocol/tokens'
import type { Nullish } from '@cowprotocol/types'

import { useBridgeSupportedTokens } from 'entities/bridgeProvider'

import type { Order } from 'legacy/state/orders/actions'

/**
 * Provider list first; then the wrapped-to-native mapping (Bungee stored the
 * WETH address in appData for a native ETH delivery, so a list match on WETH
 * must still read as ETH, the same normalization the explorer applies); then
 * the destination token list; the source-chain intermediate last, since it is
 * the wrong asset and decimals on a receipt.
 */
function pickOutputToken(
  destinationChainId: number | undefined,
  providerTokens: TokenWithLogo[] | undefined,
  listToken: TokenWithLogo | undefined,
  fallback: TokenWithLogo,
  outputTokenAddress: string | undefined,
): TokenWithLogo {
  if (!outputTokenAddress) return fallback

  const providerToken = providerTokens?.find((token) => areAddressesEqual(token.address, outputTokenAddress))
  if (providerToken) return providerToken

  const wrapped = destinationChainId ? WRAPPED_NATIVE_CURRENCIES[destinationChainId as SupportedChainId] : undefined
  if (wrapped && areAddressesEqual(wrapped.address, outputTokenAddress)) {
    return NATIVE_CURRENCIES[destinationChainId as SupportedChainId] ?? listToken ?? fallback
  }

  return listToken ?? fallback
}

/**
 * Derives a bridge output token considering swap order source (localStorage or API)
 */
export function useBridgeOrderOutputToken(
  order: Order | undefined,
  crossChainOrder: Nullish<CrossChainOrder>,
): TokenWithLogo | undefined {
  const localOrderOutputToken = order?.outputToken
  /**
   * When order was added to the store while posting order, its outputToken will be a token from destination chain
   * But when we clear localStorage, the order.outputToken will actually be an intermediate token
   * So, when order is not from localStorage cache we should take token from crossChainOrder
   */
  const isLocalOrderCached = !!order && order.inputToken.chainId !== order.outputToken.chainId

  const outputTokenAddress = crossChainOrder?.bridgingParams.outputTokenAddress
  const destinationChainId = isLocalOrderCached
    ? order.outputToken.chainId
    : crossChainOrder?.bridgingParams.destinationChainId

  const { data } = useBridgeSupportedTokens(
    isLocalOrderCached || !destinationChainId ? undefined : { buyChainId: destinationChainId },
  )

  // Second source for an API-loaded order: the destination chain's token lists.
  // The provider lists alone can miss the token (Bungee is decode-only since
  // 2026-09-10 and serves none; a live provider may not list it either), and the
  // remaining fallback is the SOURCE-chain intermediate, i.e. the wrong asset
  // and decimals on the receipt.
  const destinationTokens = useTokensByAddressMapForChain(
    isLocalOrderCached ? undefined : (destinationChainId as SupportedChainId | undefined),
  )

  return useMemo(() => {
    if (isLocalOrderCached) return localOrderOutputToken as TokenWithLogo

    const listToken = outputTokenAddress ? destinationTokens[getAddressKey(outputTokenAddress)] : undefined
    // While crossChainOrder data is still loading (or the route is unavailable)
    // the fallback keeps swapAndBridgeOverview defined in fresh sessions.
    const providerTokens = data?.isRouteAvailable === false ? undefined : data?.tokens

    return pickOutputToken(
      destinationChainId,
      providerTokens,
      listToken,
      localOrderOutputToken as TokenWithLogo,
      outputTokenAddress,
    )
  }, [isLocalOrderCached, localOrderOutputToken, data, outputTokenAddress, destinationTokens, destinationChainId])
}
