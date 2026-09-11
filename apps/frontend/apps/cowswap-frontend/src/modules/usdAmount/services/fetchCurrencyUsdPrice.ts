import { isNonEvmBridgeDestination } from '@cowprotocol/common-utils'
import { getAddressKey, SupportedChainId, mapSupportedNetworks } from '@cowprotocol/cow-sdk'
import { Fraction, Token } from '@cowprotocol/currency'
import { PersistentStateByChain } from '@cowprotocol/types'

import { RateLimitError, UnknownCurrencyError } from '../apis/errors'
import { getBffUsdPrice } from '../apis/getBffUsdPrice'
import { getCowProtocolUsdPrice } from '../apis/getCowProtocolUsdPrice'
import { DEFILLAMA_PLATFORMS, DEFILLAMA_RATE_LIMIT_TIMEOUT, getDefillamaUsdPrice } from '../apis/getDefillamaUsdPrice'

type UnknownCurrencies = { [address: string]: true }
type UnknownCurrenciesMap = PersistentStateByChain<UnknownCurrencies>

let defillamaRateLimitHitTimestamp: null | number = null

const defillamaUnknownCurrencies: UnknownCurrenciesMap = mapSupportedNetworks({})
const bffUnknownCurrencies: UnknownCurrenciesMap = mapSupportedNetworks({})

/**
 * Fetches USD price for a given currency from BFF, Defillama, or CowProtocol
 * Tries sources in that order
 */
export async function fetchCurrencyUsdPrice(currency: Token): Promise<Fraction | null> {
  const shouldSkipBff = getShouldSkipBff(currency)
  const shouldSkipDefillama = getShouldSkipDefillama(currency)

  if (defillamaRateLimitHitTimestamp && !shouldSkipDefillama) {
    defillamaRateLimitHitTimestamp = null
  }

  function getCowPrice(currency: Token): Promise<Fraction | null> {
    return getCowProtocolUsdPrice(currency).catch((error) => {
      console.error('Cannot fetch USD price', { error })
      return Promise.reject(error)
    })
  }

  // CoW's price source needs an orderbook on the chain. A bridge-only
  // destination (Monad, Sui, Tron, Hyperliquid…), Bitcoin or Solana has none,
  // so the chain of fallbacks ends at null there instead of a TypeError
  // deep inside the CoW quote lookup.
  const lastResort =
    currency.chainId in SupportedChainId ? getCowPrice : (): Promise<Fraction | null> => Promise.resolve(null)

  // Try BFF first, then fall back to Defillama, then CoW
  if (!shouldSkipBff) {
    return getBffUsdPrice(currency)
      .catch(handleErrorFactory(currency, null, bffUnknownCurrencies, getDefillamaUsdPrice))
      .catch(handleErrorFactory(currency, defillamaRateLimitHitTimestamp, defillamaUnknownCurrencies, lastResort))
  }

  // If BFF is skipped, try Defillama
  if (!shouldSkipDefillama) {
    return getDefillamaUsdPrice(currency).catch(
      handleErrorFactory(currency, defillamaRateLimitHitTimestamp, defillamaUnknownCurrencies, lastResort),
    )
  }

  // CowProtocolUsdPrice is only available for supported chains
  if (currency.chainId in SupportedChainId) {
    // If all other sources are skipped, use CoW as last resort
    return getCowPrice(currency)
  }

  return null
}

function getShouldSkipBff(currency: Token): boolean {
  // CoW's BFF only knows EVM chain ids; a non-EVM bridge destination (Sui,
  // Tron, Hyperliquid) would just log a 404 per token.
  if (isNonEvmBridgeDestination(currency.chainId)) return true
  return getShouldSkipPriceSource(currency, null, bffUnknownCurrencies, null, 0)
}

function getShouldSkipDefillama(currency: Token): boolean {
  return getShouldSkipPriceSource(
    currency,
    DEFILLAMA_PLATFORMS,
    defillamaUnknownCurrencies,
    defillamaRateLimitHitTimestamp,
    DEFILLAMA_RATE_LIMIT_TIMEOUT,
  )
}

function getShouldSkipPriceSource(
  currency: Token,
  platforms: Record<SupportedChainId, string | null> | null,
  unknownCurrenciesMap: UnknownCurrenciesMap,
  rateLimitTimestamp: null | number,
  timeout: number,
): boolean {
  const chainId = currency.chainId as SupportedChainId
  const unknownCurrenciesForChain = unknownCurrenciesMap[chainId] || {}

  if (platforms && !platforms[chainId]) return true

  if (unknownCurrenciesForChain[getAddressKey(currency.address)]) return true

  return !!rateLimitTimestamp && Date.now() - rateLimitTimestamp < timeout
}

function handleErrorFactory(
  currency: Token,
  rateLimitTimestamp: null | number,
  unknownCurrenciesMap: UnknownCurrenciesMap,
  fetchPriceFallback: (currency: Token) => Promise<Fraction | null>,
  // TODO: Replace any with proper type definitions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ((reason: any) => Fraction | PromiseLike<Fraction | null> | null) | null | undefined {
  return (error) => {
    if (error instanceof RateLimitError) {
      rateLimitTimestamp = Date.now()
    } else if (error instanceof UnknownCurrencyError) {
      // Mark currency as unknown
      const chainId = currency.chainId as SupportedChainId
      const unknownCurrenciesForChain = unknownCurrenciesMap[chainId]
      const addressKey = getAddressKey(currency.address)

      if (unknownCurrenciesForChain === undefined) {
        unknownCurrenciesMap[chainId] = { [addressKey]: true }
      } else {
        unknownCurrenciesForChain[addressKey] = true
      }
    } else {
    }

    return fetchPriceFallback(currency)
  }
}
