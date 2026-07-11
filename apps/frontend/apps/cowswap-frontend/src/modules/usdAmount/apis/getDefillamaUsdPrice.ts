import { FractionUtils } from '@cowprotocol/common-utils'
import { getAddressKey, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Fraction, Token } from '@cowprotocol/currency'

import ms from 'ms.macro'

import { fetchWithRateLimit } from 'common/utils/fetch'

import { RateLimitError, UnknownCurrencyError, UnsupportedPlatformError } from './errors'

interface DefillamaUsdQuote {
  coins: {
    [chainAndAddress: string]: {
      price: number
    }
  }
}

export const DEFILLAMA_PLATFORMS: Record<SupportedChainId, string | null> = {
  [SupportedChainId.MAINNET]: 'ethereum',
  [SupportedChainId.GNOSIS_CHAIN]: 'xdai',
  [SupportedChainId.ARBITRUM_ONE]: 'arbitrum-one',
  [SupportedChainId.BASE]: 'base',
  [SupportedChainId.SEPOLIA]: null,
  [SupportedChainId.POLYGON]: 'polygon',
  [SupportedChainId.AVALANCHE]: 'avalanche',
  [SupportedChainId.BNB]: 'bsc', // BNB Chain is called BSC in Defillama
  [SupportedChainId.LINEA]: 'linea',
  [SupportedChainId.PLASMA]: 'plasma',
  [SupportedChainId.INK]: 'ink',
  // Ophis fork: OP mainnet (chain 10)
  [10 as unknown as SupportedChainId]: 'optimism',
  // Ophis fork: Unichain mainnet (chain 130) — DefiLlama 'unichain' slug
  [130 as unknown as SupportedChainId]: 'unichain',
  // Ophis fork: MegaETH mainnet (chain 4326) — DefiLlama may not have a
  // platform slug for MegaETH yet; null disables price lookups gracefully.
  // Re-evaluate post-launch.
  [4326 as unknown as SupportedChainId]: null,
  // Ophis fork: HyperEVM mainnet (chain 999) — DefiLlama uses the
  // 'hyperliquid' platform slug for HyperEVM tokens.
  [999 as unknown as SupportedChainId]: 'hyperliquid',
}

const BASE_URL = 'https://coins.llama.fi/prices/current'
/**
 * This is a text of 429 HTTP code
 * https://saturncloud.io/blog/catching-javascript-fetch-failing-with-cloudflare-429-missing-cors-header/
 */
const FAILED_FETCH_ERROR = 'Failed to fetch'

const fetchRateLimited = fetchWithRateLimit({
  // Allow 2 requests per second
  rateLimit: {
    tokensPerInterval: 2,
    interval: 'second',
  },
  // 2 retry attempts with 100ms delay
  backoff: {
    maxDelay: ms`0.1s`,
    numOfAttempts: 2,
  },
})

export const DEFILLAMA_RATE_LIMIT_TIMEOUT = ms`1m`

export async function getDefillamaUsdPrice(currency: Token): Promise<Fraction | null> {
  const platform = DEFILLAMA_PLATFORMS[currency.chainId as SupportedChainId]

  if (!platform) throw new UnsupportedPlatformError({ cause: `Defillama does not support chain '${currency.chainId}'` })

  const key = `${platform}:${getAddressKey(currency.address)}`
  const url = `${BASE_URL}/${key}`

  return fetchRateLimited(url)
    .then((res) => res.json())
    .catch((error) => {
      if (error.message.includes(FAILED_FETCH_ERROR)) {
        throw new RateLimitError({ cause: error })
      }

      return Promise.reject(error)
    })
    .then((res: DefillamaUsdQuote) => {
      const value = res.coins[key]?.price

      if (value === undefined) {
        throw new UnknownCurrencyError({
          cause: `Defillama did not return a price for '${currency.address}' on chain '${currency.chainId}'`,
        })
      }

      return FractionUtils.fromNumber(value)
    })
}
