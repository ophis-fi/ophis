import { useMemo } from 'react'

import { NATIVE_CURRENCIES, TokenWithLogo, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import type { CrossChainOrder } from '@cowprotocol/sdk-bridging'
import { useTokensByAddressMapForChain } from '@cowprotocol/tokens'
import type { Nullish } from '@cowprotocol/types'

import { useBridgeSupportedTokens } from 'entities/bridgeProvider'
import { bungeeBridgeProvider } from 'tradingSdk/bridgingSdk'

import type { Order } from 'legacy/state/orders/actions'

import { useWarmTargetChainLists } from './useWarmTargetChainLists'

/**
 * For a BUNGEE order, the wrapped-to-native mapping first: Bungee delivered
 * native ETH while storing the destination WETH address in appData, and the
 * aggregate provider list from Across/NEAR contains WETH, so the mapping must
 * win before any address match. Other providers deliver what appData says, so
 * for them a WETH address is WETH. Then the provider list, then the destination
 * token list; the source-chain intermediate last, since it is the wrong asset
 * and decimals on a receipt.
 */
function pickOutputToken(
  destinationChainId: number | undefined,
  isBungeeOrder: boolean,
  providerTokens: TokenWithLogo[] | undefined,
  listToken: TokenWithLogo | undefined,
  fallback: TokenWithLogo,
  outputTokenAddress: string | undefined,
): TokenWithLogo {
  if (!outputTokenAddress) return fallback

  if (isBungeeOrder && destinationChainId) {
    const wrapped = WRAPPED_NATIVE_CURRENCIES[destinationChainId as SupportedChainId]
    const native = NATIVE_CURRENCIES[destinationChainId as SupportedChainId]
    if (wrapped && native && areAddressesEqual(wrapped.address, outputTokenAddress)) return native
  }

  const providerToken = providerTokens?.find((token) => areAddressesEqual(token.address, outputTokenAddress))

  return providerToken ?? listToken ?? fallback
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
  const isBungeeOrder = crossChainOrder?.provider.info.dappId === bungeeBridgeProvider.info.dappId
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
  // and decimals on the receipt. Only the connected chain's lists are loaded by
  // default, so warm the destination chain's cold slot first (best-effort,
  // no-op once loaded or hydrated from IndexedDB).
  const destinationListChainId = isLocalOrderCached ? undefined : (destinationChainId as SupportedChainId | undefined)
  useWarmTargetChainLists(destinationListChainId)
  const destinationTokens = useTokensByAddressMapForChain(destinationListChainId)

  return useMemo(() => {
    if (isLocalOrderCached) return localOrderOutputToken as TokenWithLogo

    const listToken = outputTokenAddress ? destinationTokens[getAddressKey(outputTokenAddress)] : undefined
    // While crossChainOrder data is still loading (or the route is unavailable)
    // the fallback keeps swapAndBridgeOverview defined in fresh sessions.
    const providerTokens = data?.isRouteAvailable === false ? undefined : data?.tokens

    return pickOutputToken(
      destinationChainId,
      isBungeeOrder,
      providerTokens,
      listToken,
      localOrderOutputToken as TokenWithLogo,
      outputTokenAddress,
    )
  }, [
    isLocalOrderCached,
    localOrderOutputToken,
    data,
    outputTokenAddress,
    destinationTokens,
    destinationChainId,
    isBungeeOrder,
  ])
}
