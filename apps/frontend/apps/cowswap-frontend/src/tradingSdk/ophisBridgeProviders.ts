import { ARC_ENABLED, EXTRA_ACROSS_SOURCE_CHAIN_IDS } from '@cowprotocol/common-const'
import {
  avalanche,
  bnb,
  ChainInfo,
  EvmCall,
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
import { fetchTokenList, OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'

import { FEE_ROOM_PCT, GuardedHookTerms, GUARD_GAS, OrdersOf, PCT_100 } from './ophisAcrossConstants'
import { getSignedHook, guardedHookTerms } from './ophisAcrossHooks'
import { getBridgingParams } from './ophisAcrossLogs'
import { getIntermediateTokensFromRoutes, keepTrustedSameAsset } from './ophisAcrossTokenTrust'
import { ARC_BRIDGE_CHAIN, ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'

export { placeConfirmed } from './ophisAcrossPlacement'
export { acrossValidToLimit, nearValidToLimit } from './ophisBridgeValidTo'

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
  ...(ARC_ENABLED ? [ARC_BRIDGE_CHAIN] : []),
  avalanche,
  bnb,
  plasma,
  ink,
  linea,
  UNICHAIN_BRIDGE_CHAIN,
  ROBINHOOD_BRIDGE_CHAIN,
]

// Source support requires deployed SpokePool, math helper, CoW Shed and hook
// execution. EXTRA_ACROSS_SOURCE_CHAIN_IDS keeps additional chains gated until
// their deployment and execution checks pass (including Polygon and Optimism).
export const ACROSS_EXECUTABLE_SOURCE_IDS: ReadonlySet<number> = new Set<number>([
  SupportedChainId.MAINNET,
  SupportedChainId.ARBITRUM_ONE,
  SupportedChainId.BASE,
  ...EXTRA_ACROSS_SOURCE_CHAIN_IDS,
])

export class OphisAcrossBridgeProvider extends AcrossBridgeProvider {
  private readonly guardedHooks = new WeakMap<EvmCall, GuardedHookTerms>()
  private trustedList?: Promise<TokenInfo[]>
  private readonly ordersOf: OrdersOf | undefined

  constructor({
    ordersOf,
    ...options
  }: NonNullable<ConstructorParameters<typeof AcrossBridgeProvider>[0]> & { ordersOf?: OrdersOf } = {}) {
    super(options)
    this.ordersOf = ordersOf
  }

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
  // the target. Either way the candidates come from Across's own lists, so
  // only trusted same-asset ones survive (keepTrustedSameAsset). (super throws
  // ONLY_SELL_ORDER_SUPPORTED for non-SELL, which propagates through the await.)
  async getIntermediateTokens(request: QuoteBridgeRequest): Promise<TokenInfo[]> {
    // Same executable-source gate as getBuyTokens: Across can only build a
    // deposit from a chain with the SpokePool + math helper, so a non-executable
    // source has no valid intermediate regardless of what the symbol match or
    // the route fallback would surface. Returning [] here (not just in
    // getBuyTokens) keeps the direct getQuote path from advancing past this to a
    // later getUnsignedBridgeCall throw.
    if (!ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId)) return []

    const bySymbol = await super.getIntermediateTokens(request)
    const candidates = bySymbol.length > 0 ? bySymbol : await getIntermediateTokensFromRoutes(this.api, request)

    return keepTrustedSameAsset(() => this.trustedTokens(), request, candidates)
  }
  async getUnsignedBridgeCall(request: QuoteBridgeRequest, quote: AcrossQuoteResult): Promise<EvmCall> {
    const call = await super.getUnsignedBridgeCall(request, quote)
    this.guardedHooks.set(call, guardedHookTerms(this.cowShedSdk, request, quote))
    return call
  }

  async getBridgingParams(
    ...args: Parameters<AcrossBridgeProvider['getBridgingParams']>
  ): ReturnType<AcrossBridgeProvider['getBridgingParams']> {
    return getBridgingParams(this.getStatus.bind(this), ...args)
  }

  async getGasLimitEstimationForHook(request: QuoteBridgeRequest): Promise<number> {
    return (await super.getGasLimitEstimationForHook(request)) + GUARD_GAS
  }

  async getSignedHook(...args: Parameters<AcrossBridgeProvider['getSignedHook']>): Promise<BridgeHook> {
    return getSignedHook(this.cowShedSdk, this.info.dappId, this.guardedHooks.get(args[1]), this.ordersOf, ...args)
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
  // The same goes for an intermediate keepTrustedSameAsset would drop: the SDK
  // serves intermediates from a cache shared across tabs and app versions,
  // without calling getIntermediateTokens.
  async getQuote(request: QuoteBridgeRequest): Promise<AcrossQuoteResult> {
    // The cached-intermediate path skips getIntermediateTokens, and with it the source gate.
    if (!ACROSS_EXECUTABLE_SOURCE_IDS.has(request.sellTokenChainId)) {
      throw new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {
        reason: 'Across is not executable from this source chain',
        sellTokenChainId: request.sellTokenChainId,
      })
    }
    if (request.sellTokenDecimals !== request.buyTokenDecimals) {
      throw new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {
        reason: 'sell/buy token decimals differ; Across deposit outputAmount is computed in sell-token units',
        sellTokenDecimals: request.sellTokenDecimals,
        buyTokenDecimals: request.buyTokenDecimals,
      })
    }

    const [trusted] = await keepTrustedSameAsset(() => this.trustedTokens(), request, [
      { address: request.sellTokenAddress },
    ])
    if (!trusted) {
      throw new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {
        reason: 'the intermediate is not a trusted token of the destination asset',
        sellTokenAddress: request.sellTokenAddress,
      })
    }

    // Placing the order quotes Across again and takes a fee up to FEE_ROOM_PCT
    // higher (assertPlaceable). Upstream's Across minimum has no slippage at all,
    // so the minimum shown keeps that room: what arrives is never less than it.
    const quote = await super.getQuote(request)
    const { beforeFee, afterSlippage } = quote.amountsAndCosts
    afterSlippage.buyAmount -= (beforeFee.buyAmount * FEE_ROOM_PCT) / PCT_100
    return quote
  }

  /** The Ophis token list, loaded once per provider; a failed load is dropped so the next quote retries. */
  protected trustedTokens(): Promise<TokenInfo[]> {
    this.trustedList ??= fetchTokenList({ source: OPHIS_TOKENS_LIST_SOURCE }).then(
      (state) => state.list.tokens,
      (error) => {
        this.trustedList = undefined
        throw error
      },
    )
    return this.trustedList
  }
}
