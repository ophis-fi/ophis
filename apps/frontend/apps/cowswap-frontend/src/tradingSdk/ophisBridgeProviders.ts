import { avalanche, bnb, ChainInfo, ink, linea, plasma, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'
import {
  AcrossBridgeProvider,
  BungeeBridgeProvider,
  BuyTokensParams,
  GetProviderBuyTokens,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'

import { ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'

// Across's own API base (keyless). The SDK's internal AcrossApi uses the same
// host and the app CSP already allows it, so a direct GET here needs no proxy.
const ACROSS_API_URL = 'https://app.across.to/api'

interface AcrossRoute {
  originToken: string
}

/**
 * sdk-bridging 4.0.2 hardcodes each provider's network list far below what the
 * provider APIs actually serve (verified against the live APIs, 2026-08-10):
 * Across covers every Ophis chain except Gnosis — including Robinhood Chain
 * (USDG routes) and Unichain — and Bungee's manual pipeline covers Unichain,
 * Ink and Linea. These subclasses widen ONLY the network list; quotes, token
 * lists and route availability still come live from the provider APIs, and
 * unroutable corridors stay disabled through the existing getBuyTokens probes.
 *
 * The widened list makes these chains bridge DESTINATIONS. Whether a chain can
 * be a bridge SOURCE is governed separately by BRIDGE_SOURCE_CHAIN_IDS
 * (common-const): sources need on-chain execution machinery these chains don't
 * have yet.
 */
const ACROSS_EXTRA_NETWORKS: ChainInfo[] = [
  avalanche,
  bnb,
  plasma,
  ink,
  linea,
  UNICHAIN_BRIDGE_CHAIN,
  ROBINHOOD_BRIDGE_CHAIN,
]

// Plasma and Robinhood Chain are deliberately absent: Bungee lists them as
// chains but serves zero routes on the manual pipeline this SDK consumes.
const BUNGEE_EXTRA_NETWORKS: ChainInfo[] = [ink, linea, UNICHAIN_BRIDGE_CHAIN]

// Chains Across can actually EXECUTE a bridge deposit from with sdk-bridging
// 4.0.2: both ACROSS_SPOOK_CONTRACT_ADDRESSES and ACROSS_MATH_CONTRACT_ADDRESSES
// have entries only for these (getUnsignedBridgeCall throws on any other
// source). Deliberately narrower than the SDK's own 5-network source claim —
// Polygon/Optimism lack the math helper upstream and have always failed there;
// NEAR Intents covers every corridor that overlap loses.
const ACROSS_EXECUTABLE_SOURCE_IDS: ReadonlySet<number> = new Set<number>([
  SupportedChainId.MAINNET,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.BASE,
])

export class OphisAcrossBridgeProvider extends AcrossBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...ACROSS_EXTRA_NETWORKS]
  }

  // Upstream getBuyTokens() reports availability from the DESTINATION token
  // list alone (sellChainId is ignored), so with the widened network list the
  // availability probe would light corridors Across cannot execute from —
  // e.g. Gnosis -> Robinhood Chain, where Across is the only provider serving
  // the destination but cannot bridge from the source, leaving an enabled
  // chain chip whose every quote fails. Gate availability on the executable
  // source set; other providers still contribute via the BridgingSdk union.
  async getBuyTokens(params: BuyTokensParams): Promise<GetProviderBuyTokens> {
    if (params.sellChainId !== undefined && !ACROSS_EXECUTABLE_SOURCE_IDS.has(params.sellChainId)) {
      return { tokens: [], isRouteAvailable: false }
    }

    return super.getBuyTokens(params)
  }

  // The base class picks source intermediates by EXACT symbol match against the
  // buy token's symbol. That misses Across's cross-asset and chain-aliased
  // routes: buying USDG on Robinhood Chain (symbol "USDG") bridges from either
  // USDG-MAINNET (Ethereum — a chain-alias suffix) or USDC (many chains —
  // cross-asset), neither of which shares the symbol "USDG", so the symbol
  // match returns nothing and the corridor dies with NO_INTERMEDIATE_TOKENS.
  // When the symbol match is empty, fall back to Across's authoritative
  // available-routes, which enumerates the real origin tokens that bridge to
  // the target. Fallback-only, so every currently-working corridor is
  // untouched. (super throws ONLY_SELL_ORDER_SUPPORTED for non-SELL, which
  // propagates through the await.)
  async getIntermediateTokens(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    const bySymbol = await super.getIntermediateTokens(request)
    if (bySymbol.length > 0) return bySymbol

    return this.getIntermediateTokensFromRoutes(request)
  }

  private async getIntermediateTokensFromRoutes(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    const { sellTokenChainId, buyTokenChainId, buyTokenAddress } = request
    const params = new URLSearchParams({
      originChainId: String(sellTokenChainId),
      destinationChainId: String(buyTokenChainId),
      destinationToken: buyTokenAddress,
    })

    let routes: AcrossRoute[]
    try {
      const response = await fetch(`${ACROSS_API_URL}/available-routes?${params.toString()}`)
      if (!response.ok) return []
      routes = (await response.json()) as AcrossRoute[]
    } catch {
      return []
    }
    if (!Array.isArray(routes) || routes.length === 0) return []

    const originAddresses = new Set(routes.map((route) => route.originToken?.toLowerCase()).filter(Boolean))
    // Return the SDK's own TokenInfo objects (with decimals/symbol/logo) for the
    // route origins, so the downstream quote path gets the shape it expects.
    const tokens = await this.api.getSupportedTokens()
    return tokens.filter(
      (token) => token.chainId === sellTokenChainId && originAddresses.has(token.address?.toLowerCase()),
    )
  }
}

export class OphisBungeeBridgeProvider extends BungeeBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return [...(await super.getNetworks()), ...BUNGEE_EXTRA_NETWORKS]
  }
}
