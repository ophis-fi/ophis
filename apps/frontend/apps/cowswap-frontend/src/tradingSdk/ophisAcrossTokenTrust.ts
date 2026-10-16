import { USDG_ROBINHOOD, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { getTimeoutAbortController } from '@cowprotocol/common-utils'
import { areAddressesEqual, getAddressKey, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { AVAILABLE_ROUTES_TIMEOUT_MS } from './ophisAcrossConstants'

// The Ophis list keeps on-chain symbols: USDT0 is Tether's own omnichain USDT,
// and BNB Chain's Binance-Peg Ethereum reads ETH, the asset WETH wraps.
const SYMBOL_ALIASES = new Map([
  ['USDT0', 'USDT'],
  ['USD₮0', 'USDT'],
  ['ETH', 'WETH'],
])

const isSameToken = (a: TokenInfo, b: TokenInfo): boolean =>
  a.chainId === b.chainId && areAddressesEqual(a.address, b.address)

function assetSymbol(token: TokenInfo): string {
  const symbol = token.symbol?.toUpperCase() ?? ''
  return SYMBOL_ALIASES.get(symbol) ?? symbol
}

// The one intended cross-asset corridor: Across routes USDC into and out of
// Robinhood Chain's USDG (the chain has no USDC, see USDG_ROBINHOOD), both
// 6 decimals. Any other USDG stays its own asset.
const isUsdgCorridor = (usdg: TokenInfo, usdc: TokenInfo): boolean =>
  isSameToken(usdg, USDG_ROBINHOOD) && assetSymbol(usdc) === 'USDC'

function isSameAsset(source: TokenInfo, destination: TokenInfo): boolean {
  if (source.decimals !== destination.decimals) return false
  if (isUsdgCorridor(source, destination) || isUsdgCorridor(destination, source)) return true
  return !!assetSymbol(source) && assetSymbol(source) === assetSymbol(destination)
}

// A token as Ophis trusts it: the pinned wrapped gas token, else its Ophis list entry.
function findTrusted(listed: TokenInfo[], chainId: number, address: string): TokenInfo | undefined {
  const wrapped: TokenInfo | undefined = WRAPPED_NATIVE_CURRENCIES[chainId as SupportedChainId]
  if (wrapped && areAddressesEqual(wrapped.address, address)) return wrapped
  return listed.find((token) => token.chainId === chainId && areAddressesEqual(token.address, address))
}

export async function getIntermediateTokensFromRoutes(
  api: AcrossBridgeProvider['api'],
  request: QuoteBridgeRequest,
): Promise<TokenInfo[]> {
  const { sellTokenChainId, buyTokenChainId, buyTokenAddress } = request

  // Whole body guarded: any failure — network, a timeout, a malformed/garbage
  // routes response, a non-string originToken, the token-list fetch — degrades
  // to "no intermediate found" rather than crashing the quote pipeline.
  try {
    // Through the SDK's AcrossApi, so this request carries the configured
    // integratorId and API key like every other Across call (the SDK also
    // validates the route shape and rejects garbage as INVALID_API_JSON_RESPONSE).
    const routes = await api.getAvailableRoutes(
      {
        originChainId: String(sellTokenChainId),
        destinationChainId: String(buyTokenChainId),
        destinationToken: buyTokenAddress,
      },
      { signal: getTimeoutAbortController(AVAILABLE_ROUTES_TIMEOUT_MS).signal },
    )
    if (routes.length === 0) return []

    // Normalize both sides with the repo's canonical address key (not a raw
    // toLowerCase) so matching tracks the SDK's address semantics.
    const originKeys = new Set(
      routes
        .map((route) => (typeof route?.originToken === 'string' ? getAddressKey(route.originToken) : undefined))
        .filter((key): key is ReturnType<typeof getAddressKey> => Boolean(key)),
    )
    if (originKeys.size === 0) return []

    // Return the SDK's own TokenInfo objects (with decimals/symbol/logo) for
    // the route origins, so the downstream quote path gets the shape it wants.
    const tokens = await api.getSupportedTokens()
    return tokens.filter((token) => token.chainId === sellTokenChainId && originKeys.has(getAddressKey(token.address)))
  } catch {
    return []
  }
}

// The order buys the intermediate, and Across's token list (symbol match) or
// routes pick it, so a spoofed or mislabeled entry could make it buy a token
// no relayer carries. Keep only tokens Ophis trusts that are the same asset as
// the destination by trusted symbol and decimals (or the USDG corridor),
// rebuilt from the trusted entry; fail closed when the list cannot be loaded.
export async function keepTrustedSameAsset(
  trustedTokens: () => Promise<TokenInfo[]>,
  request: QuoteBridgeRequest,
  candidates: Pick<TokenInfo, 'address'>[],
): Promise<TokenInfo[]> {
  if (candidates.length === 0) return []

  const listed = await trustedTokens().catch(() => null)
  if (!listed) return []

  const destination = findTrusted(listed, request.buyTokenChainId, request.buyTokenAddress)
  if (!destination || destination.decimals !== request.buyTokenDecimals) return []

  return candidates.flatMap((candidate) => {
    const source = findTrusted(listed, request.sellTokenChainId, candidate.address)
    if (!source || !isSameAsset(source, destination)) return []

    const { chainId, address, decimals, symbol, name } = source
    return [{ chainId, address, decimals, symbol, name }]
  })
}
