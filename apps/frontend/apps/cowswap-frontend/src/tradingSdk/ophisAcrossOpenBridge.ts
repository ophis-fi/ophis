import { getRpcProvider } from '@cowprotocol/common-const'
import { areAddressesEqual, OrderStatus, SigningScheme, SupportedChainId } from '@cowprotocol/cow-sdk'

import { BRIDGE_LIVE, BRIDGE_OPEN, GuardedHookTerms, OrdersOf, ORDERS_UNREAD, SHED_CALLS } from './ophisAcrossConstants'
import { loadHooks, saveHooks } from './ophisAcrossPlacedHooks'

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
export async function assertNoOpenBridge(
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
