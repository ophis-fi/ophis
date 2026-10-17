import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { Erc20__factory } from '@cowprotocol/cowswap-abis'
import { HOOK_DAPP_BRIDGE_PROVIDER_PREFIX } from '@cowprotocol/sdk-bridging'
import { Interface } from '@ethersproject/abi'

// A stalled available-routes request must not hang the quote — it is ABORTED
// (not just raced) at the timeout and degrades to "no intermediate found" like
// every other route-fetch failure, so retries never pile up open connections.
export const AVAILABLE_ROUTES_TIMEOUT_MS = 10_000

// The guard call (see getSignedHook) asks the shed for the order's minimum
// output less 0.1%: the signed order may land a hair under the quoted minimum
// (fees, rounding). Run early on an empty shed, passing the guard costs a
// griefer 99.9% of that output, bridged to the user. A balance already in the
// shed lowers that cost, to nothing once it covers the guard, so placement
// refuses a shed holding LEFTOVER_SHARE of the guard or more (assertPlaceable).
export const GUARD_MARGIN_BPS = 10n
// Anyone can send dust to a user's (public) shed: refusing any balance would let
// them block the user's bridges for the price of that dust. Below a tenth of the
// guard the leftover is simply bridged along, and passing the guard early still
// costs a griefer at least 90% of the bridge; blocking the user costs a tenth of it.
export const LEFTOVER_SHARE = 10n
// Gas for the guard call, on top of the SDK's hook estimate. The settlement
// forwards exactly the hook gas limit and ignores a hook that runs out.
export const GUARD_GAS = 50_000
// Across SpokePool on Ethereum, Arbitrum and Base (read on-chain 2026-10-15):
// depositV3 reverts if its quoteTimestamp is in the future or more than
// depositQuoteTimeBuffer (3600 s) old, or its fillDeadline is past or more than
// fillDeadlineBuffer (21600 s) ahead. The hook runs as late as the order's
// validTo, and relayers need FILL_MARGIN to fill an order settled at the end.
export const ACROSS_QUOTE_TIME_BUFFER = 3_600n
// How far the quote time may be ahead of the sell chain's latest block as our RPC
// reports it: Across quotes a block the RPC may not have seen yet, and the hook
// only runs in a later settlement block, by which time that block has passed.
export const QUOTE_TIME_SKEW = 60n
export const FILL_DEADLINE_BUFFER = 21_600n
export const FILL_MARGIN = 900n
// Exclusivity lets one named relayer fill first: it must end within 5 minutes.
// Across sends it as an offset, or above the SpokePool's
// MAX_EXCLUSIVITY_PERIOD_SECONDS (31536000, read on-chain) as a timestamp.
export const MAX_EXCLUSIVITY = 300n
export const EXCLUSIVITY_OFFSET_MAX = 31_536_000n
// How far the relay fee (1e18 = 100%) may rise between the quote shown and the
// order placed: 0.1% of the bridged amount, which the minimum shown leaves room for.
export const PCT_100 = 10n ** 18n
export const FEE_ROOM_PCT = 10n ** 15n
// Placing the order quotes Across again; acrossValidToLimit keeps this much slack for it.
export const QUOTE_TIME_MARGIN = 300n
// Upstream's ACROSS_HOOK_DAPP_ID, which every Across quote's providerInfo carries.
export const ACROSS_DAPP_ID = `${HOOK_DAPP_BRIDGE_PROVIDER_PREFIX}/across`
// Upstream's NEAR_INTENTS_HOOK_DAPP_ID, likewise.
export const NEAR_DAPP_ID = `${HOOK_DAPP_BRIDGE_PROVIDER_PREFIX}/near-intents`
// NEAR must see the deposit before its quote's deadline: the order expires this long before it.
export const NEAR_DEPOSIT_MARGIN = 300

export const ERC20 = Erc20__factory.createInterface()
// The logs that tie a settlement to the order's own Across deposit (getBridgingParams).
export const BRIDGE_LOGS = new Interface([
  'event Trade(address indexed owner, address sellToken, address buyToken, uint256 sellAmount, uint256 buyAmount, uint256 feeAmount, bytes orderUid)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)',
])
// The shed factory's call that runs a signed hook, and the shed's record of the nonces it used.
export const ERC1271 = new Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)'])
export const SHED_CALLS = new Interface([
  'function executeHooks((address target, uint256 value, bytes callData, bool allowFailure, bool isDelegateCall)[] calls, bytes32 nonce, uint256 deadline, address user, bytes signature)',
  'function nonces(bytes32 nonce) view returns (bool)',
])

export const QUOTE_CHANGED = 'The bridge quote changed while placing the order. Please try again.'
export const BRIDGE_OPEN =
  'Another bridge from this wallet is still open. Wait until it settles or expires, then try again.'
export const BRIDGE_LIVE =
  'An earlier bridge from this wallet could still run until it expires. Wait until then, then try again.'
export const BRIDGE_PLACING =
  'Another bridge from this wallet is being placed in another tab. Finish it there, then try again.'
export const ORDERS_UNREAD = "Could not check this wallet's open orders. Please try again."
export const NO_LOCKS = 'This browser cannot place a bridge safely. Please update it or use another browser.'
export const HOOKS_UNSAVED =
  'This browser cannot keep track of your bridges (its site storage is unavailable or full), so none is placed. Please free some site data or use another browser.'
export const NOT_OWNER =
  'The bridge must be signed by the wallet placing the order. Please reconnect your wallet and try again.'
export const SHED_NOT_EMPTY =
  'Your Account Proxy already holds this bridge token from an earlier bridge. Recover it under Account > Account Proxy (select the proxy, then the token, then Recover funds) and try again.'

export interface GuardedHookTerms {
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
export type OrdersOf = (
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
