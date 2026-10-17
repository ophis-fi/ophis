// The Ophis Across bridge provider, adapted from the frontend's so the CLI bridges like swap.ophis.fi:
//   apps/frontend/apps/cowswap-frontend/src/tradingSdk/ophisBridgeProviders.ts (and the ophisAcross* modules it uses)
//   apps/frontend/libs/common-const/src/acrossApiOptions.ts (the integrator tag)
// The CLI's own checks of what it signs live in bridge.ts. A fix to either side's route rules belongs in both.
import {
  avalanche,
  bnb,
  type ChainInfo,
  type EvmChainInfo,
  getAddressKey,
  getGlobalAdapter,
  ink,
  linea,
  plasma,
  type SignerLike,
  SupportedChainId,
  type TokenInfo,
} from '@cowprotocol/cow-sdk'
import type { EvmCall } from '@cowprotocol/sdk-config'
import {
  AcrossBridgeProvider,
  type AcrossQuoteResult,
  type BridgeHook,
  BridgeProviderQuoteError,
  BridgeQuoteErrors,
  type BuyTokensParams,
  type GetProviderBuyTokens,
  type QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'
import { loadCuratedTokenList, NATIVE_SYMBOL, OPHIS_TOKEN_LIST_URL, PUBLIC_RPCS } from '@ophis/mcp-server/src/ophis.ts'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { WRAPPED } from './trade.ts'

// Frontend flags, at their defaults (unset): Arc off, no extra Across source chains.
const ARC_ENABLED = false
const EXTRA_ACROSS_SOURCE_CHAIN_IDS: number[] = []
// @cowprotocol/common-utils helper, reduced to what the class uses: an abort signal after `ms`.
const getTimeoutAbortController = (ms: number) => ({ signal: AbortSignal.timeout(ms) })
// @cowprotocol/cow-sdk helper (not in the CLI's version): addresses compared case-insensitively.
const areAddressesEqual = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
// @cowprotocol/cowswap-abis, reduced to what the class uses: encoding transfer, and reading balanceOf. The read goes
// through the SDK's global adapter, which the CLI always points at the bridge's source chain (with --rpc if given).
const Erc20__factory = {
  createInterface: () => ({
    encodeFunctionData: (_name: 'transfer', [to, amount]: [string, bigint]) => encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to as Address, amount] }),
  }),
  connect: (token: string, chainId: number) => ({
    balanceOf: async (owner: string) => {
      const adapter = getGlobalAdapter()
      if (Number(await adapter.getChainId()) !== chainId) throw new Error('the bridge source chain is not the one being read')
      const value = BigInt((await adapter.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] } as never)) as bigint)
      return { toBigInt: () => value, isZero: () => value === 0n }
    },
  }),
}
// @cowprotocol/common-const getRpcProvider: the CLI reads through the global adapter, so this only names the chain.
const getRpcProvider = (chainId: number) => chainId
// @cowprotocol/common-const token the class pins (test/bridge.test.ts checks it against the frontend's).
const token = (chainId: number, address: string, symbol: string, name: string, decimals: number) => ({ chainId, address, symbol, name, decimals }) as TokenInfo
const USDG_ROBINHOOD = token(4663, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', 'USDG', 'Global Dollar', 6)
// The pinned wrapped gas tokens: the CLI's own table (trade.ts), verified on-chain.
const WRAPPED_NATIVE_CURRENCIES: Record<number, TokenInfo> = Object.fromEntries(
  Object.entries(WRAPPED).map(([id, [address, symbol]]) => [id, token(Number(id), address, symbol, symbol, 18)]),
)
// @cowprotocol/tokens fetchTokenList, reduced to the Ophis list: the same URL and checked loader the CLI trusts.
const OPHIS_TOKENS_LIST_SOURCE = OPHIS_TOKEN_LIST_URL
async function fetchTokenList({ source }: { source: string }): Promise<{ list: { tokens: TokenInfo[] } }> {
  const raw = (await loadCuratedTokenList(source, fetch)) as Partial<TokenInfo>[]
  const tokens = raw.filter(
    (t): t is TokenInfo => typeof t?.chainId === 'number' && typeof t.address === 'string' && typeof t.symbol === 'string' && typeof t.decimals === 'number',
  )
  return { list: { tokens } }
}

/** Destination-only chains, described with the fields the bridging SDK reads (toBridgeChainInfo in the frontend). */
function bridgeChain(id: number, label: string): EvmChainInfo {
  const symbol = NATIVE_SYMBOL[id] ?? 'ETH'
  return {
    id,
    label,
    eip155Label: label,
    addressPrefix: 'eth',
    isTestnet: false,
    color: '#000000',
    logo: { light: '', dark: '' },
    docs: { url: 'https://ophis.fi', name: `${label} Docs` },
    website: { url: 'https://ophis.fi', name: label },
    blockExplorer: { url: '', name: label },
    nativeCurrency: { chainId: id, address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', name: symbol, symbol, decimals: 18, logoUrl: '' },
    contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
    rpcUrls: { default: { http: [...(PUBLIC_RPCS[id] ?? [])] } },
  } as unknown as EvmChainInfo
}
const UNICHAIN_BRIDGE_CHAIN = bridgeChain(130, 'Unichain')
const ROBINHOOD_BRIDGE_CHAIN = bridgeChain(4663, 'Robinhood Chain')
const ARC_BRIDGE_CHAIN = bridgeChain(5042, 'Arc')

/** Across integrator tag issued to Ophis. 2 bytes, public: it rides in query strings and deposit calldata. */
export const ACROSS_INTEGRATOR_ID = '0x0311'

/** Across's calldata delimiter for the on-chain integrator tag (their toolkit's DOMAIN_CALLDATA_DELIMITER). */
export const ACROSS_CALLDATA_DELIMITER = '0x1dc0de'

/**
 * Appends Across's on-chain integrator tag (delimiter + ID) to a hook's
 * calldata. Across attributes a deposit by the LAST bytes of the transaction
 * that made it (their toolkit checks with endsWith). Our deposit runs inside a
 * CoW Shed post-hook, so the transaction is the solver's settle(): its tail is
 * the last post-interaction's calldata, i.e. this hook. Zero-padding first so
 * the tagged bytes end on a 32-byte boundary means every ABI layer above
 * (HooksTrampoline, settle) adds no padding of its own and the tag stays the
 * tail. The callee ignores trailing calldata, as Across's own deposits rely on.
 *
 * ponytail: assumes the bridge hook is the settlement's last post-interaction
 * (the driver's layout). A solver appending its own post-interaction moves the
 * tag off the tail and Across simply does not attribute; nothing else changes.
 */
export function tagAcrossIntegratorCalldata(callData: string): string {
  const hex = callData.startsWith('0x') ? callData.slice(2) : callData
  const tag = ACROSS_CALLDATA_DELIMITER.slice(2) + ACROSS_INTEGRATOR_ID.slice(2)
  const padBytes = (32 - (((hex.length + tag.length) / 2) % 32)) % 32
  return `0x${hex}${'00'.repeat(padBytes)}${tag}`
}

// A stalled available-routes request must not hang the quote — it is ABORTED
// (not just raced) at the timeout and degrades to "no intermediate found" like
// every other route-fetch failure, so retries never pile up open connections.
const AVAILABLE_ROUTES_TIMEOUT_MS = 10_000

// The guard call (see getSignedHook) asks the shed for the order's minimum
// output less 0.1%: the signed order may land a hair under the quoted minimum
// (fees, rounding). Run early on an empty shed, passing the guard costs a
// griefer 99.9% of that output, bridged to the user. A balance already in the
// shed lowers that cost, to nothing once it covers the guard, so placement
// refuses a shed holding LEFTOVER_SHARE of the guard or more (assertPlaceable).
const GUARD_MARGIN_BPS = 10n
// Anyone can send dust to a user's (public) shed: refusing any balance would let
// them block the user's bridges for the price of that dust. Below a tenth of the
// guard the leftover is simply bridged along, and passing the guard early still
// costs a griefer at least 90% of the bridge; blocking the user costs a tenth of it.
const LEFTOVER_SHARE = 10n
// Gas for the guard call, on top of the SDK's hook estimate. The settlement
// forwards exactly the hook gas limit and ignores a hook that runs out.
const GUARD_GAS = 50_000
// Across SpokePool on Ethereum, Arbitrum and Base (read on-chain 2026-10-15):
// depositV3 reverts once its quoteTimestamp is more than depositQuoteTimeBuffer
// (3600 s) old, or past its fillDeadline. The hook runs as late as the order's
// validTo, and relayers need FILL_MARGIN to fill an order settled at the end.
const ACROSS_QUOTE_TIME_BUFFER = 3_600n
const FILL_MARGIN = 900n
// sdk-trading's DEFAULT_QUOTE_VALIDITY, for a quote request without validFor.
const SDK_QUOTE_VALIDITY = 1_800

const ERC20 = Erc20__factory.createInterface()

const SHED_NOT_EMPTY =
  'Your Account Proxy already holds this bridge token from an earlier bridge. Recover it under Account > Account Proxy (select the proxy, then the token, then Recover funds) and try again.'

interface GuardedHookTerms {
  owner: string
  shed: string
  guard: { target: string; callData: string }
  minIn: bigint
  quoteTimestamp: bigint
  fillDeadline: bigint
  quoteValidFor: number
}

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

/**
 * Refusals that run before any wallet prompt. The SDK signs the hook twice: while
 * quoting, with the app's own quote key and a deadline of local time + validFor,
 * and discards that hook; then when the order is placed, as the order owner, with
 * the order's validTo (bridge.ts checks it against the quote and the fill deadline before signing).
 */
async function assertPlaceable(
  chainId: SupportedChainId,
  terms: GuardedHookTerms,
  deadline: bigint,
  signer?: SignerLike,
): Promise<void> {
  // A deadline the quoting hook could carry may come from a skewed local clock.
  const quotingDeadline = BigInt(Math.floor(Date.now() / 1000) + terms.quoteValidFor)
  const outlivesDeposit =
    deadline - terms.quoteTimestamp > ACROSS_QUOTE_TIME_BUFFER || deadline + FILL_MARGIN > terms.fillDeadline
  if (deadline > quotingDeadline && outlivesDeposit) {
    throw new Error('The bridge quote changed while placing the order. Please try again.')
  }

  // Only the hook the order owner signs is placed, and only the swap flow shows
  // this message (a quote error would read "Error loading price").
  const adapter = getGlobalAdapter()
  const signerAddress = await (signer ? adapter.createSigner(signer) : adapter.signer).getAddress()
  if (!areAddressesEqual(signerAddress, terms.owner)) return

  // Read on the sell chain's own RPC: without a wallet the global adapter stays on
  // the chain the page loaded with, where the token may not exist.
  const balance = await Erc20__factory.connect(terms.guard.target, getRpcProvider(chainId)).balanceOf(terms.shed)
  if (balance.toBigInt() * LEFTOVER_SHARE >= terms.minIn) throw new Error(SHED_NOT_EMPTY)
}

// A token as Ophis trusts it: the pinned wrapped gas token, else its Ophis list entry.
function findTrusted(listed: TokenInfo[], chainId: number, address: string): TokenInfo | undefined {
  const wrapped: TokenInfo | undefined = WRAPPED_NATIVE_CURRENCIES[chainId as SupportedChainId]
  if (wrapped && areAddressesEqual(wrapped.address, address)) return wrapped
  return listed.find((token) => token.chainId === chainId && areAddressesEqual(token.address, address))
}

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
    const candidates = bySymbol.length > 0 ? bySymbol : await this.getIntermediateTokensFromRoutes(request)

    return this.keepTrustedSameAsset(request, candidates)
  }

  /**
   * Upstream's Across deposit program, plus the guard call getSignedHook puts
   * first: the shed transfers the order's minimum output (less
   * GUARD_MARGIN_BPS) to itself, which reverts while the shed is empty. Also
   * keeps what assertPlaceable checks: the owner, the shed and the Across
   * quote's time limits.
   */
  async getUnsignedBridgeCall(request: QuoteBridgeRequest, quote: AcrossQuoteResult): Promise<EvmCall> {
    const call = await super.getUnsignedBridgeCall(request, quote)
    const shed = this.cowShedSdk.getCowShedAccount(request.sellTokenChainId, request.account)
    const minIn = (request.amount * (10_000n - GUARD_MARGIN_BPS)) / 10_000n

    this.guardedHooks.set(call, {
      owner: request.account,
      shed,
      guard: { target: request.sellTokenAddress, callData: ERC20.encodeFunctionData('transfer', [shed, minIn]) },
      minIn,
      quoteTimestamp: BigInt(quote.suggestedFees.timestamp),
      fillDeadline: BigInt(quote.suggestedFees.fillDeadline),
      quoteValidFor: request.validFor ?? SDK_QUOTE_VALIDITY,
    })

    return call
  }

  async getGasLimitEstimationForHook(request: QuoteBridgeRequest): Promise<number> {
    return (await super.getGasLimitEstimationForHook(request)) + GUARD_GAS
  }

  /**
   * The signed CoW Shed hook: the guard call, then upstream's deposit program,
   * with Across's on-chain integrator tag appended to the factory calldata (see
   * tagAcrossIntegratorCalldata; the SDK reads deposits back from the
   * FundsDeposited event, never from this calldata).
   *
   * The hook is public in the order's appData and anyone may run it. Run early
   * on the empty shed, the deposit would send nothing and burn the nonce, so the
   * settlement's run would fail and leave the order's output in the shed; the
   * guard makes that early run revert whole instead.
   */
  async getSignedHook(...args: Parameters<AcrossBridgeProvider['getSignedHook']>): Promise<BridgeHook> {
    const [chainId, unsignedCall, bridgeHookNonce, deadline, hookGasLimit, signer] = args
    const terms = this.guardedHooks.get(unsignedCall)
    if (!terms) throw new Error('Across bridge call was not built by this provider')

    // The swap flow shows a refusal's message as is.
    await assertPlaceable(chainId, terms, deadline, signer)

    const { signedMulticall, cowShedAccount, gasLimit } = await this.cowShedSdk.signCalls({
      calls: [
        {
          target: terms.guard.target,
          value: 0n,
          callData: terms.guard.callData,
          allowFailure: false,
          isDelegateCall: false,
        },
        {
          target: unsignedCall.to,
          value: unsignedCall.value,
          callData: unsignedCall.data,
          allowFailure: false,
          isDelegateCall: true,
        },
      ],
      chainId,
      signer,
      gasLimit: BigInt(hookGasLimit),
      deadline,
      nonce: bridgeHookNonce,
    })

    return {
      postHook: {
        target: signedMulticall.to,
        callData: tagAcrossIntegratorCalldata(signedMulticall.data),
        gasLimit: gasLimit.toString(),
        dappId: this.info.dappId,
      },
      recipient: cowShedAccount,
    }
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
    // A quote reached without getIntermediateTokens (the SDK's cached intermediates) skips its source gate.
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

    const [trusted] = await this.keepTrustedSameAsset(request, [{ address: request.sellTokenAddress }])
    if (!trusted) {
      throw new BridgeProviderQuoteError(BridgeQuoteErrors.NO_ROUTES, {
        reason: 'the intermediate is not a trusted token of the destination asset',
        sellTokenAddress: request.sellTokenAddress,
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

  // The order buys the intermediate, and Across's token list (symbol match) or
  // routes pick it, so a spoofed or mislabeled entry could make it buy a token
  // no relayer carries. Keep only tokens Ophis trusts that are the same asset as
  // the destination by trusted symbol and decimals (or the USDG corridor),
  // rebuilt from the trusted entry; fail closed when the list cannot be loaded.
  private async keepTrustedSameAsset(
    request: QuoteBridgeRequest,
    candidates: Pick<TokenInfo, 'address'>[],
  ): Promise<TokenInfo[]> {
    if (candidates.length === 0) return []

    const listed = await this.trustedTokens().catch(() => null)
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
}
