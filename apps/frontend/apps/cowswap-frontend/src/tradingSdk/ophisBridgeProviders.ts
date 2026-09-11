import { EXTRA_ACROSS_SOURCE_CHAIN_IDS, tagAcrossIntegratorCalldata } from '@cowprotocol/common-const'
import { getTimeoutAbortController } from '@cowprotocol/common-utils'
import {
  avalanche,
  bnb,
  ChainInfo,
  getAddressKey,
  ink,
  linea,
  plasma,
  SupportedChainId,
  TokenInfo,
} from '@cowprotocol/cow-sdk'
import {
  AcrossBridgeProvider,
  AcrossQuoteResult,
  BridgeHook,
  BridgeProviderQuoteError,
  BridgeQuoteErrors,
  BuyTokensParams,
  GetProviderBuyTokens,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'

import { ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'

// A stalled available-routes request must not hang the quote — it is ABORTED
// (not just raced) at the timeout and degrades to "no intermediate found" like
// every other route-fetch failure, so retries never pile up open connections.
const AVAILABLE_ROUTES_TIMEOUT_MS = 10_000

/**
 * sdk-bridging 4.0.2 hardcodes Across's network list far below what the
 * provider API actually serves (verified against the live API, 2026-08-10):
 * Across covers every Ophis chain except Gnosis — including Robinhood Chain
 * (USDG routes) and Unichain. This subclass widens ONLY the network list;
 * quotes, token lists and route availability still come live from the provider
 * API, and unroutable corridors stay disabled through the existing getBuyTokens
 * probes.
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

// Chains Across can actually EXECUTE a bridge deposit from with sdk-bridging
// 4.0.2: both ACROSS_SPOOK_CONTRACT_ADDRESSES and ACROSS_MATH_CONTRACT_ADDRESSES
// have entries only for these (getUnsignedBridgeCall throws on any other
// source). Deliberately narrower than the SDK's own 5-network source claim —
// Polygon/Optimism lack the math helper upstream and have always failed there;
// NEAR Intents covers every corridor that overlap loses. Ink/Linea join via the
// flagged EXTRA_ACROSS_SOURCE_CHAIN_IDS (their SpokePool ships upstream; our
// patch adds the math helper) — the same shared const BRIDGE_SOURCE_CHAIN_IDS
// spreads, so the executable set and the source set cannot disagree.
export const ACROSS_EXECUTABLE_SOURCE_IDS: ReadonlySet<number> = new Set<number>([
  SupportedChainId.MAINNET,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.BASE,
  ...EXTRA_ACROSS_SOURCE_CHAIN_IDS,
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
    // Same executable-source gate as getBuyTokens: Across can only build a
    // deposit from a chain with the SpokePool + math helper, so a non-executable
    // source has no valid intermediate regardless of what the symbol match or
    // the route fallback would surface. Returning [] here (not just in
    // getBuyTokens) keeps the direct getQuote path from advancing past this to a
    // later getUnsignedBridgeCall throw.
    if (!ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId)) return []

    const bySymbol = await super.getIntermediateTokens(request)
    if (bySymbol.length > 0) return bySymbol

    return this.getIntermediateTokensFromRoutes(request)
  }

  // The Across deposit hook computes depositV3's outputAmount ON-CHAIN as
  // balanceOf(sell token) minus the relay fee, in the SELL token's units
  // (weiroll multiplyAndSubtract); it never rescales for decimals. Since the
  // sdk-bridging patch quotes with the explicit inputToken/outputToken pair,
  // Across's cross-asset routes are quotable, and some pair a 6-decimal stable
  // with an 18-decimal one (USDC -> USDC-BNB, USDT -> USDT-BNB, live 2026-09-10).
  // Such a deposit would offer 100e6 of input for ~1e-10 of output and be filled
  // instantly. Refuse them here, the one method every Across quote passes
  // through, before any fee request; the UI renders NO_ROUTES as "No routes found".
  /**
   * Same signed CoW Shed hook as upstream, with Across's on-chain integrator
   * tag appended to its calldata (see tagAcrossIntegratorCalldata). Nothing
   * decodes this calldata later: the SDK reads Across deposits back from the
   * FundsDeposited event, not from the hook.
   */
  async getSignedHook(...args: Parameters<AcrossBridgeProvider['getSignedHook']>): Promise<BridgeHook> {
    const hook = await super.getSignedHook(...args)
    return { ...hook, postHook: { ...hook.postHook, callData: tagAcrossIntegratorCalldata(hook.postHook.callData) } }
  }

  async getQuote(request: QuoteBridgeRequest): Promise<AcrossQuoteResult> {
    if (request.sellTokenDecimals !== request.buyTokenDecimals) {
      throw new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {
        reason: 'sell/buy token decimals differ; Across deposit outputAmount is computed in sell-token units',
        sellTokenDecimals: request.sellTokenDecimals,
        buyTokenDecimals: request.buyTokenDecimals,
      })
    }

    return super.getQuote(request)
  }

  private async getIntermediateTokensFromRoutes(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    const { sellTokenChainId, buyTokenChainId, buyTokenAddress } = request

    // Whole body guarded: any failure — network, a timeout, a malformed/garbage
    // routes response, a non-string originToken, the token-list fetch — degrades
    // to "no intermediate found" rather than crashing the quote pipeline.
    try {
      // Through the SDK's AcrossApi, so this request carries the configured
      // integratorId and API key like every other Across call (the SDK also
      // validates the route shape and rejects garbage as INVALID_API_JSON_RESPONSE).
      const routes = await this.api.getAvailableRoutes(
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
      const tokens = await this.api.getSupportedTokens()
      return tokens.filter(
        (token) => token.chainId === sellTokenChainId && originKeys.has(getAddressKey(token.address)),
      )
    } catch {
      return []
    }
  }
}
