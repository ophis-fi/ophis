import { areAddressesEqual, getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import type { CrossChainOrder } from '@cowprotocol/sdk-bridging'
import type { TokenInfo } from '@uniswap/token-lists'

import { useBridgeProviderBuyTokens } from './useBridgeProviderBuyTokens'

import { NATIVE_TOKEN_PER_NETWORK, WRAPPED_NATIVE_ADDRESS } from '../../../const'
import { useTokenList } from '../../../hooks/useTokenList'

export interface CrossChainTokens<T = TokenInfo | undefined> {
  sourceToken: T
  intermediateToken: T
  destinationToken: T
}

export function useCrossChainTokens(crossChainOrder: CrossChainOrder): CrossChainTokens {
  const {
    bridgingParams: { sourceChainId, destinationChainId, inputTokenAddress, outputTokenAddress },
    order,
    provider,
  } = crossChainOrder
  const { data: sourceTokens } = useTokenList(sourceChainId)
  // The destination chain's token list is the fallback source: a provider that
  // no longer serves a token list (Bungee is decode-only, its API is 410) or
  // one that does not list the token must not leave the received asset blank.
  const { data: destinationListTokens } = useTokenList(destinationChainId)

  const { data: destinationChainTokens } = useBridgeProviderBuyTokens(provider, destinationChainId)

  const sourceToken = sourceTokens && sourceTokens[getAddressKey(inputTokenAddress)]
  const intermediateToken = sourceTokens && sourceTokens[getAddressKey(order.buyToken)]
  // Provider list (with its wrapped -> native mapping) first, token list second,
  // so a Bungee delivery reported as WETH keeps rendering as ETH.
  const destinationToken = outputTokenAddress
    ? (resolveDestinationToken(destinationChainId, destinationChainTokens ?? {}, outputTokenAddress) ??
      destinationListTokens[getAddressKey(outputTokenAddress)])
    : undefined

  return { sourceToken, intermediateToken, destinationToken }
}

function resolveDestinationToken(
  destinationChainId: SupportedChainId,
  destinationChainTokens: Record<string, TokenInfo>,
  outputTokenAddress: string,
): TokenInfo | undefined {
  const address = getAddressKey(outputTokenAddress)
  const token = destinationChainTokens[address]
  // The app's own maps, not the SDK's: they know the Ophis chains (Unichain
  // 130, Robinhood Chain 4663) the upstream sdk-config does not.
  const wrappedAddress = WRAPPED_NATIVE_ADDRESS[destinationChainId]
  const nativeToken = NATIVE_TOKEN_PER_NETWORK[destinationChainId]

  // Bungee has problems with WETH/ETH
  // So we need to map them
  if (!token && wrappedAddress && nativeToken && areAddressesEqual(wrappedAddress, address)) {
    return nativeToken as TokenInfo
  }

  return token
}
