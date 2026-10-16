import { getRpcProvider } from '@cowprotocol/common-const'
import { areAddressesEqual, getAddressKey, getGlobalAdapter, SignerLike, SupportedChainId } from '@cowprotocol/cow-sdk'
import { Erc20__factory } from '@cowprotocol/cowswap-abis'
import { BridgeQuoteResults } from '@cowprotocol/sdk-bridging'

import { BRIDGE_QUOTE_ACCOUNT } from 'common/constants/bridgeQuoteAccount'

import {
  ACROSS_DAPP_ID,
  ACROSS_QUOTE_TIME_BUFFER,
  BRIDGE_PLACING,
  EXCLUSIVITY_OFFSET_MAX,
  FEE_ROOM_PCT,
  FILL_DEADLINE_BUFFER,
  FILL_MARGIN,
  GuardedHookTerms,
  LEFTOVER_SHARE,
  MAX_EXCLUSIVITY,
  NOT_OWNER,
  NO_LOCKS,
  OrdersOf,
  QUOTE_CHANGED,
  SHED_NOT_EMPTY,
} from './ophisAcrossConstants'
import { assertNoOpenBridge } from './ophisAcrossOpenBridge'

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
export async function assertPlaceable(
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
