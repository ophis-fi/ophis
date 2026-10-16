import {
  ARC_ENABLED,
  EXTRA_ACROSS_SOURCE_CHAIN_IDS,
  getRpcProvider,
  tagAcrossIntegratorCalldata,
  USDG_ROBINHOOD,
  WRAPPED_NATIVE_CURRENCIES,
} from '@cowprotocol/common-const'
import { getTimeoutAbortController } from '@cowprotocol/common-utils'
import {
  areAddressesEqual,
  avalanche,
  bnb,
  ChainInfo,
  EvmCall,
  getAddressKey,
  getGlobalAdapter,
  ink,
  isCoWSettlementContract,
  linea,
  OrderStatus,
  plasma,
  SignerLike,
  SigningScheme,
  SupportedChainId,
  TokenInfo,
} from '@cowprotocol/cow-sdk'
import { Erc20__factory } from '@cowprotocol/cowswap-abis'
import {
  AcrossBridgeProvider,
  AcrossQuoteResult,
  BridgeHook,
  BridgeProviderQuoteError,
  BridgeQuoteErrors,
  BridgeQuoteResults,
  BuyTokensParams,
  GetProviderBuyTokens,
  HOOK_DAPP_BRIDGE_PROVIDER_PREFIX,
  QuoteBridgeRequest,
} from '@cowprotocol/sdk-bridging'
import { CowShedHooks } from '@cowprotocol/sdk-cow-shed'
import { fetchTokenList, OPHIS_TOKENS_LIST_SOURCE } from '@cowprotocol/tokens'
import { Interface } from '@ethersproject/abi'

import { utils } from 'ethers'

import { BRIDGE_QUOTE_ACCOUNT } from 'modules/tradeQuote/utils/getBridgeQuoteSigner'

import { ARC_BRIDGE_CHAIN, ROBINHOOD_BRIDGE_CHAIN, UNICHAIN_BRIDGE_CHAIN } from './ophisBridgeChains'

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
// depositV3 reverts if its quoteTimestamp is in the future or more than
// depositQuoteTimeBuffer (3600 s) old, or its fillDeadline is past or more than
// fillDeadlineBuffer (21600 s) ahead. The hook runs as late as the order's
// validTo, and relayers need FILL_MARGIN to fill an order settled at the end.
const ACROSS_QUOTE_TIME_BUFFER = 3_600n
const FILL_DEADLINE_BUFFER = 21_600n
const FILL_MARGIN = 900n
// Exclusivity lets one named relayer fill first: it must end within 5 minutes.
// Across sends it as an offset, or above the SpokePool's
// MAX_EXCLUSIVITY_PERIOD_SECONDS (31536000, read on-chain) as a timestamp.
const MAX_EXCLUSIVITY = 300n
const EXCLUSIVITY_OFFSET_MAX = 31_536_000n
// How far the relay fee (1e18 = 100%) may rise between the quote shown and the
// order placed: 0.1% of the bridged amount, which the minimum shown leaves room for.
const PCT_100 = 10n ** 18n
const FEE_ROOM_PCT = 10n ** 15n
// Placing the order quotes Across again; acrossValidToLimit keeps this much slack for it.
const QUOTE_TIME_MARGIN = 300n
// Upstream's ACROSS_HOOK_DAPP_ID, which every Across quote's providerInfo carries.
const ACROSS_DAPP_ID = `${HOOK_DAPP_BRIDGE_PROVIDER_PREFIX}/across`
// Upstream's NEAR_INTENTS_HOOK_DAPP_ID, likewise.
const NEAR_DAPP_ID = `${HOOK_DAPP_BRIDGE_PROVIDER_PREFIX}/near-intents`
// NEAR must see the deposit before its quote's deadline: the order expires this long before it.
const NEAR_DEPOSIT_MARGIN = 300

const ERC20 = Erc20__factory.createInterface()
// The logs that tie a settlement to the order's own Across deposit (getBridgingParams).
const BRIDGE_LOGS = new Interface([
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
])
const wordAddress = (word: string): string => `0x${word.slice(-40)}`
// The shed factory's call that runs a signed hook, and the shed's record of the nonces it used.
const ERC1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
const SHED_CALLS = new Interface([
  'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)',
  'function nonces(bytes32 nonce) view returns (bool)',
])

const QUOTE_CHANGED = 'The bridge quote changed while placing the order. Please try again.'
const BRIDGE_OPEN = 'Another bridge from this wallet is still open. Wait until it settles or expires, then try again.'
const BRIDGE_LIVE =
  'An earlier bridge from this wallet could still run until it expires. Wait until then, then try again.'
const BRIDGE_PLACING =
  'Another bridge from this wallet is being placed in another tab. Finish it there, then try again.'
const ORDERS_UNREAD = "Could not check this wallet's open orders. Please try again."
const NO_LOCKS = 'This browser cannot place a bridge safely. Please update it or use another browser.'
const HOOKS_UNSAVED =
  'This browser cannot keep track of your bridges (its site storage is unavailable or full), so none is placed. Please free some site data or use another browser.'
const NOT_OWNER =
  'The bridge must be signed by the wallet placing the order. Please reconnect your wallet and try again.'
const SHED_NOT_EMPTY =
  'Your Account Proxy already holds this bridge token from an earlier bridge. Recover it under Account > Account Proxy (select the proxy, then the token, then Recover funds) and try again.'

interface GuardedHookTerms {
  owner: string
  receiver: string // where the deposit pays: the whole shed balance goes there
  shed: string
  guard: { target: string; callData: string }
  minIn: bigint
  pct: bigint
  quoteTimestamp: bigint
  fillDeadline: bigint
  exclusivityDeadline: bigint
  exclusiveRelayer: string
}

// The wallet's orders on a chain, from the app's orderbook (wired in bridgingSdk.ts).
type OrdersOf = (
  chainId: SupportedChainId,
  owner: string,
) => Promise<
  {
    uid: string
    status: string
    receiver?: string | null
    signingScheme?: string
    fullAppData?: string | null
  }[]
>

// The relay fee of the Across quote the user confirmed, set by placeConfirmed just
// before its order is placed and used once by the hook that placement signs:
// placing quotes Across again, and that fee is held to this one.
const confirmed = new Map<string, { fee?: bigint }>()

// The fee the user confirmed for the wallet's placement in flight, used once.
function takeConfirmedFee(owner: string): bigint | undefined {
  const slot = confirmed.get(getAddressKey(owner))
  const fee = slot?.fee
  if (slot) slot.fee = undefined // one placement per confirmation
  return fee
}

function quotedFee(bridge: BridgeQuoteResults): bigint | undefined {
  try {
    return BigInt(JSON.parse(bridge.quoteBody ?? '').totalRelayFee.pct)
  } catch {
    return undefined
  }
}

/**
 * Places the order of the quote the user confirmed: the trade flows hand it
 * the bridge quote they hold for it (tradeQuoteState.bridgeQuote). For an
 * Across bridge, the placement's re-quoted fee is held to that quote's fee,
 * no other bridge of the wallet is placed in this browser meanwhile (two tabs
 * could both find no open bridge before either is posted). The hook it signs
 * is remembered from that moment (rememberHook in getSignedHook): the SDK
 * uploads it with the order's appData before the order is even signed.
 */
export async function placeConfirmed<T>(
  bridgeQuote: BridgeQuoteResults | null | undefined,
  owner: string,
  place: () => Promise<T>,
): Promise<T> {
  if (bridgeQuote?.providerInfo.dappId !== ACROSS_DAPP_ID) return place()
  const fee = quotedFee(bridgeQuote)
  const wallet = getAddressKey(owner)
  const run = async (): Promise<T> => {
    confirmed.set(wallet, { fee })
    try {
      return await place()
    } finally {
      confirmed.delete(wallet)
    }
  }
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) throw new Error(NO_LOCKS)
  return locks.request(`ophisBridge:v0:${getAddressKey(owner)}`, { ifAvailable: true }, (lock) =>
    lock ? run() : Promise.reject(new Error(BRIDGE_PLACING)),
  )
}

// The bridge hooks this browser placed, per wallet: an earlier hook that can
// still run would carry a later bridge's output, to its own recipient and at
// its own fee. The orderbook alone cannot show them all: a native ETH order is
// listed only once mined, and anyone can push an order out of the newest ones
// with pre-sign orders "from" the wallet. Each record is kept until its
// deadline passes: one whose nonce is used blocks nothing but stays, so a reorg
// that undoes that use still finds it. Kept per wallet (each wallet's
// placements run under its own lock); a browser that cannot keep them places
// no bridge.
type PlacedHook = { chainId: number; nonce: string; deadline: string }
const hooksKey = (owner: string): string => `ophisBridgeHooks:v0:${getAddressKey(owner)}`
function loadHooks(owner: string): PlacedHook[] {
  try {
    const hooks: unknown = JSON.parse(localStorage.getItem(hooksKey(owner)) ?? '[]')
    if (Array.isArray(hooks)) return hooks
  } catch {
    // unreadable: refused below rather than taken for no hooks
  }
  throw new Error(HOOKS_UNSAVED)
}
function saveHooks(owner: string, hooks: PlacedHook[]): void {
  try {
    localStorage.setItem(hooksKey(owner), JSON.stringify(hooks))
  } catch {
    throw new Error(HOOKS_UNSAVED)
  }
}
function rememberHook(owner: string, hook: PlacedHook): void {
  const others = loadHooks(owner).filter((kept) => kept.chainId !== hook.chainId || kept.nonce !== hook.nonce)
  saveHooks(owner, [...others, hook])
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
 * The latest validTo an order may carry with this bridge quote. The placed hook
 * may run until validTo, when the Across deposit must still accept the quote time
 * (with QUOTE_TIME_MARGIN to spare) and leave relayers FILL_MARGIN. Infinity for
 * any other provider's quote.
 */
export function acrossValidToLimit(bridgeQuote: BridgeQuoteResults | null): number {
  if (bridgeQuote?.providerInfo.dappId !== ACROSS_DAPP_ID) return Infinity

  return Math.min(
    bridgeQuote.quoteTimestamp + Number(ACROSS_QUOTE_TIME_BUFFER - QUOTE_TIME_MARGIN),
    quotedFillDeadline(bridgeQuote.quoteBody) - Number(FILL_MARGIN),
  )
}

/**
 * The latest validTo an order may carry with a NEAR Intents quote. The order pays
 * NEAR's deposit address when it fills, and NEAR refunds a deposit made after the
 * quote's deadline (fixed when quoting, 30 min on) instead of bridging it, while
 * the order would otherwise run for the whole swap deadline (up to 12 h). The
 * deadline is the one NEAR attested (the quoteBody is the attested quote). 0, so
 * no order, when it cannot be read; Infinity for any other provider's quote.
 */
export function nearValidToLimit(bridgeQuote: BridgeQuoteResults | null): number {
  if (bridgeQuote?.providerInfo.dappId !== NEAR_DAPP_ID) return Infinity

  try {
    const deadline = Date.parse(JSON.parse(bridgeQuote.quoteBody ?? '').deadline) / 1000
    return Number.isFinite(deadline) ? Math.floor(deadline) - NEAR_DEPOSIT_MARGIN : 0
  } catch {
    return 0
  }
}

// An Across quoteBody is its stringified suggested-fees response.
function quotedFillDeadline(quoteBody: string | undefined): number {
  try {
    return Number(JSON.parse(quoteBody ?? '{}').fillDeadline ?? Infinity)
  } catch {
    return Infinity
  }
}

/**
 * Whether the hook's Across deposit can run, by the sell chain's clock `now`, at
 * any time until the order's validTo (`deadline`): the SpokePool reverts it
 * otherwise, leaving the order's output in the shed.
 */
function depositRuns(terms: GuardedHookTerms, deadline: bigint, now: bigint): boolean {
  const { quoteTimestamp, fillDeadline, exclusivityDeadline: exclusivity, exclusiveRelayer } = terms
  const exclusiveUntil =
    exclusivity === 0n ? 0n : exclusivity <= EXCLUSIVITY_OFFSET_MAX ? now + exclusivity : exclusivity

  return (
    quoteTimestamp <= now &&
    deadline - quoteTimestamp <= ACROSS_QUOTE_TIME_BUFFER &&
    fillDeadline <= now + FILL_DEADLINE_BUFFER &&
    deadline + FILL_MARGIN <= fillDeadline &&
    (exclusivity === 0n || BigInt(exclusiveRelayer) !== 0n) &&
    exclusiveUntil <= now + MAX_EXCLUSIVITY
  )
}

/**
 * Refusals that run before any wallet prompt. The SDK signs the hook twice: while
 * quoting, with the app's own quote account (also the placeholder owner with no
 * wallet connected), and discards that hook; then when the order is placed, as
 * the order owner, after quoting Across again. That second quote is what the
 * deposit carries: it must be the fee shown, and its terms must let the deposit
 * run, by the sell chain's own clock, at any time until the order's validTo.
 */
async function assertPlaceable(
  chainId: SupportedChainId,
  terms: GuardedHookTerms,
  deadline: bigint,
  signer: SignerLike | undefined,
  ordersOf: OrdersOf | undefined,
): Promise<boolean> {
  const adapter = getGlobalAdapter()
  const signerAddress = await (signer ? adapter.createSigner(signer) : adapter.signer).getAddress()
  if (areAddressesEqual(signerAddress, BRIDGE_QUOTE_ACCOUNT)) return false
  // A hook for the owner's shed signed by anyone else would fail on-chain, stranding the order's output.
  if (!areAddressesEqual(signerAddress, terms.owner)) throw new Error(NOT_OWNER)

  // Only the swap flow shows these messages (a quote error would read "Error loading price").
  const shown = takeConfirmedFee(terms.owner)
  if (shown === undefined || terms.pct > shown + FEE_ROOM_PCT) throw new Error(QUOTE_CHANGED)

  // Read on the sell chain's own RPC: without a wallet the global adapter stays on
  // the chain the page loaded with, where the token may not exist.
  const provider = getRpcProvider(chainId)
  const now = BigInt((await provider.getBlock('latest')).timestamp)
  if (!depositRuns(terms, deadline, now)) throw new Error(QUOTE_CHANGED)
  await assertNoOpenBridge(chainId, terms, ordersOf, now)

  // The deposit sends the whole shed balance to this order's recipient: dust may
  // go along to the owner, but nothing already there may go to someone else.
  const balance = (await Erc20__factory.connect(terms.guard.target, provider).balanceOf(terms.shed)).toBigInt()
  const toOwner = areAddressesEqual(terms.receiver, terms.owner)
  if (toOwner ? balance * LEFTOVER_SHARE >= terms.minIn : balance > 0n) throw new Error(SHED_NOT_EMPTY)
  return true
}

/**
 * Two bridges from one wallet at once share its shed: the first hook to run
 * carries both outputs, to its own recipient, and the other's guard then fails.
 * So no bridge is placed while another order of the wallet into the shed is
 * open, or while an earlier one's signed hook could still run: a hook stays
 * valid until its own deadline unless its nonce was used, even once its order
 * is cancelled or filled, and run after this order's payout it would bridge
 * this output to that one's recipient. The hooks come from this browser's own
 * records (rememberHook) and from the orderbook, for those placed elsewhere.
 * ponytail: the orderbook part reads the newest 5,000 orders (bridgingSdk.ts).
 */
async function assertNoOpenBridge(
  chainId: SupportedChainId,
  terms: GuardedHookTerms,
  ordersOf: OrdersOf | undefined,
  now: bigint,
): Promise<void> {
  if (!ordersOf) throw new Error(ORDERS_UNREAD)
  const orders = await ordersOf(chainId, terms.owner).catch(() => {
    throw new Error(ORDERS_UNREAD)
  })
  const intoShed = orders.filter((order) => areAddressesEqual(order.receiver, terms.shed))
  if (intoShed.some((order) => order.status === OrderStatus.OPEN)) throw new Error(BRIDGE_OPEN)

  // Only orders the owner signed: a cancelled or filled one, or an expired one that was not pre-signed (anyone can
  // list a pre-sign order "from" the wallet, with any hook in its appData, and let it expire).
  const signed = intoShed.filter(
    ({ status, signingScheme }) =>
      status === OrderStatus.CANCELLED ||
      status === OrderStatus.FULFILLED ||
      (status === OrderStatus.EXPIRED && signingScheme !== SigningScheme.PRESIGN),
  )
  const listed = signed.flatMap((order) => shedHooks(order.fullAppData)).filter((hook) => hook.deadline > now)
  const owned = loadHooks(terms.owner)
  const here = owned.filter((hook) => hook.chainId === chainId && BigInt(hook.deadline) > now)
  const live = [...new Set([...here.map(({ nonce }) => nonce), ...listed.map(({ nonce }) => nonce.toLowerCase())])]
  const provider = getRpcProvider(chainId)
  const used = await Promise.all(
    live.map((nonce) =>
      provider.call({ to: terms.shed, data: SHED_CALLS.encodeFunctionData('nonces', [nonce]) }).then(
        (answer) => answer !== '0x' && BigInt(answer) !== 0n,
        () => {
          throw new Error(ORDERS_UNREAD)
        },
      ),
    ),
  )
  // Only this chain's expired records go (see rememberHook's notes): used ones stay until their deadline.
  saveHooks(terms.owner, [...owned.filter((hook) => hook.chainId !== chainId), ...here])
  if (used.includes(false)) throw new Error(BRIDGE_LIVE)
}

/**
 * The CoW Shed hooks an order's appData carries (metadata.hooks.post), with the
 * nonce and deadline they were signed with (a native ETH order's validTo is the
 * maximum; its hook's deadline is the real one). A post-hook that does not
 * decode as executeHooks is no shed hook, and cannot run as one.
 */
function shedHooks(fullAppData: string | null | undefined): { nonce: string; deadline: bigint }[] {
  try {
    const hooks: { callData?: string }[] = JSON.parse(fullAppData ?? '')?.metadata?.hooks?.post ?? []
    return hooks.flatMap(({ callData }) => {
      try {
        const { nonce, deadline } = SHED_CALLS.decodeFunctionData('executeHooks', callData ?? '0x')
        return [{ nonce: String(nonce), deadline: BigInt(String(deadline)) }]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

/**
 * Whether the hook the SDK signed passes the shed's own check: signed by the
 * order owner (ECDSA, or EIP-1271 for a contract wallet) over exactly these
 * calls, nonce and deadline, for the owner's shed.
 */
async function signedByOwner(
  chainId: SupportedChainId,
  terms: GuardedHookTerms,
  calls: Parameters<CowShedHooks['infoToSign']>[0],
  nonce: string,
  deadline: bigint,
  callData: string,
): Promise<boolean> {
  const decoded = (() => {
    try {
      return SHED_CALLS.decodeFunctionData('executeHooks', callData)
    } catch {
      return undefined // not a shed hook at all
    }
  })()
  if (!decoded || !areAddressesEqual(decoded.user, terms.owner)) return false
  const { signature } = decoded
  const { domain, types, message } = new CowShedHooks(chainId).infoToSign(calls, nonce, deadline, terms.shed)
  const digest = utils._TypedDataEncoder.hash(domain, types, message)
  const provider = getRpcProvider(chainId)
  if ((await provider.getCode(terms.owner)) === '0x')
    return areAddressesEqual(utils.recoverAddress(digest, signature), terms.owner)
  const answer = await provider.call({
    to: terms.owner,
    data: ERC1271.encodeFunctionData('isValidSignature', [digest, signature]),
  })
  return answer.slice(0, 10).toLowerCase() === '0x1626ba7e'
}

// A log decoded as one of BRIDGE_LOGS, or nothing (another event, or an ERC-721 Transfer).
type BridgeLog = { address: string; event: ReturnType<Interface['parseLog']> }
function parseBridgeLog(log: { address: string; topics: string[]; data: string }): BridgeLog[] {
  try {
    return [{ address: log.address, event: BRIDGE_LOGS.parseLog(log) }]
  } catch {
    return []
  }
}

/**
 * Who paid the input of the deposit at `logs[i]`: depositV3 pulls it from its
 * caller, then emits the event, so its pull is the last Transfer of the input
 * token into the SpokePool before it, unless an earlier deposit used it (a WETH
 * deposit paid in native ETH logs no Transfer). Anyone can name a shed as
 * depositor, but only the shed's signed hook can pull a non-zero amount out of
 * it (a zero transfer needs no allowance, so a zero deposit proves nothing).
 */
function pulledFrom(logs: BridgeLog[], i: number): string | undefined {
  const { address: spokePool, event } = logs[i]
  const token = wordAddress(event.args.inputToken)
  const pull = logs
    .slice(0, i)
    .reverse()
    .find(
      (log) =>
        (log.event.name === 'FundsDeposited' && areAddressesEqual(log.address, spokePool)) ||
        (log.event.name === 'Transfer' &&
          areAddressesEqual(log.address, token) &&
          areAddressesEqual(log.event.args.to, spokePool)),
    )
  const paid =
    pull?.event.name === 'Transfer' && event.args.inputAmount.gt(0) && pull.event.args.value.eq(event.args.inputAmount)
  return paid ? pull?.event.args.from : undefined
}

// The bridge the order's appData records (sdk-bridging writes metadata.bridging).
function bridgingOf(fullAppData: string | null | undefined): { chainId: string; token: string } | null {
  try {
    const bridging = JSON.parse(fullAppData ?? '')?.metadata?.bridging
    const { destinationChainId, destinationTokenAddress } = bridging ?? {}
    return typeof destinationTokenAddress === 'string' && destinationChainId !== undefined
      ? { chainId: String(destinationChainId), token: destinationTokenAddress }
      : null
  } catch {
    return null
  }
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

    const fees = quote.suggestedFees
    const { sellTokenAddress, account } = request

    this.guardedHooks.set(call, {
      owner: account,
      receiver: request.receiver || account,
      shed,
      guard: { target: sellTokenAddress, callData: ERC20.encodeFunctionData('transfer', [shed, minIn]) },
      minIn,
      pct: BigInt(fees.totalRelayFee.pct),
      quoteTimestamp: BigInt(fees.timestamp),
      fillDeadline: BigInt(fees.fillDeadline),
      exclusivityDeadline: BigInt(fees.exclusivityDeadline),
      exclusiveRelayer: fees.exclusiveRelayer,
    })

    return call
  }

  /**
   * Upstream pairs the order with the batch's deposit at the index of the
   * order's trade among ALL the batch's trades: another order's deposit, or
   * none, when the batch settles other trades too. Here the settlement (as
   * upstream knows it) must have traded this order, then paid its output into
   * the shed: a non-zero transfer after the Trade (pre-hooks run before any
   * Trade; a zero transfer needs no allowance). The order's hook runs after that
   * payout, so its deposit is the first after it that pulled its input out of
   * the shed (pulledFrom), to the chain and token the order's appData names.
   */
  async getBridgingParams(
    ...[chainId, order, txHash, settlementOverride]: Parameters<AcrossBridgeProvider['getBridgingParams']>
  ): ReturnType<AcrossBridgeProvider['getBridgingParams']> {
    const { receiver: shed, buyToken, uid } = order
    const bridging = bridgingOf(order.fullAppData)
    if (!shed || !bridging) return null
    const receipt = await getRpcProvider(chainId as SupportedChainId).getTransactionReceipt(txHash)
    if (receipt?.status !== 1) return null

    const logs = receipt.logs.flatMap(parseBridgeLog)
    const settlement = (address: string): boolean =>
      isCoWSettlementContract(address, chainId as SupportedChainId) ||
      areAddressesEqual(settlementOverride?.[chainId as SupportedChainId], address)
    const traded = logs.findIndex(
      ({ address, event }) =>
        event.name === 'Trade' &&
        settlement(address) &&
        String(event.args.orderUid).toLowerCase() === uid.toLowerCase(),
    )
    const payout = logs.findIndex(
      ({ address, event }, i) =>
        traded >= 0 &&
        i > traded &&
        event.name === 'Transfer' &&
        areAddressesEqual(address, buyToken) &&
        areAddressesEqual(event.args.from, logs[traded].address) &&
        areAddressesEqual(event.args.to, shed) &&
        event.args.value.gt(0),
    )
    if (payout < 0) return null
    const own = logs.find(
      ({ event }, i) =>
        i > payout &&
        event.name === 'FundsDeposited' &&
        areAddressesEqual(wordAddress(event.args.depositor), shed) &&
        areAddressesEqual(wordAddress(event.args.inputToken), buyToken) &&
        areAddressesEqual(wordAddress(event.args.outputToken), bridging.token) &&
        event.args.destinationChainId.toString() === bridging.chainId &&
        areAddressesEqual(pulledFrom(logs, i), shed),
    )
    if (!own) return null

    const deposit = own.event.args
    const params = {
      inputTokenAddress: wordAddress(deposit.inputToken),
      outputTokenAddress: wordAddress(deposit.outputToken),
      inputAmount: deposit.inputAmount.toBigInt(),
      outputAmount: deposit.outputAmount.toBigInt(),
      owner: shed,
      quoteTimestamp: deposit.quoteTimestamp,
      fillDeadline: deposit.fillDeadline,
      recipient: wordAddress(deposit.recipient),
      sourceChainId: chainId,
      destinationChainId: deposit.destinationChainId.toNumber(),
      bridgingId: deposit.depositId.toString(),
    }
    return { params, status: await this.getStatus(params.bridgingId, chainId) }
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
    const placing = await assertPlaceable(chainId, terms, deadline, signer, this.ordersOf)

    const calls = [
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
    ]
    const { signedMulticall, cowShedAccount, gasLimit } = await this.cowShedSdk.signCalls({
      calls,
      chainId,
      signer,
      gasLimit: BigInt(hookGasLimit),
      deadline,
      nonce: bridgeHookNonce,
    })
    // The app's signer follows the selected account: switched while placing, it signs for another wallet's shed, or
    // (between the SDK's two reads of it) returns this shed with a signature by another wallet. Either way the hook
    // would not run, and the order's output would stay in the shed.
    if (placing && !areAddressesEqual(cowShedAccount, terms.shed)) throw new Error(NOT_OWNER)
    if (placing && !(await signedByOwner(chainId, terms, calls, bridgeHookNonce, deadline, signedMulticall.data))) {
      throw new Error(NOT_OWNER)
    }
    if (placing) {
      // Public once its order is posted, which may happen without this tab hearing back: remembered now, or the
      // placement stops here.
      const hook = { chainId, nonce: bridgeHookNonce.toLowerCase(), deadline: String(deadline) }
      rememberHook(terms.owner, hook)
    }

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

    // Placing the order quotes Across again and takes a fee up to FEE_ROOM_PCT
    // higher (assertPlaceable). Upstream's Across minimum has no slippage at all,
    // so the minimum shown keeps that room: what arrives is never less than it.
    const quote = await super.getQuote(request)
    const { beforeFee, afterSlippage } = quote.amountsAndCosts
    afterSlippage.buyAmount -= (beforeFee.buyAmount * FEE_ROOM_PCT) / PCT_100
    return quote
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
