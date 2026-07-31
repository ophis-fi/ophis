/**
 * Domain types for the "ophis-multi-order" (basket) Phase A flow.
 */
import type { DecomposedLeg } from './pure/decomposition'

/** Which signing path a basket uses. */
export type BasketTier =
  /** Default: one EIP-712 prompt per leg, placed sequentially. */
  | 'stepped'
  /** Smart account: one EIP-5792 wallet_sendCalls batch of setPreSignature calls. */
  | 'batch'

/** Per-leg lifecycle. Independent CoW orders, so states advance per leg. */
export type BasketLegStatus =
  | 'pending' // composed, not yet placed
  | 'signing' // awaiting the user's signature / presign
  | 'open' // submitted to the orderbook, resting
  | 'filled' // executed
  | 'cancelling' // a cancel was requested
  | 'cancelled' // soft-cancelled (unfilled)
  | 'expired' // passed validTo without filling
  | 'failed' // signature/submit failed

/**
 * Statuses at which a leg is still cancellable (or retry-cancellable):
 *  - open / signing: resting or mid-signature, not yet filled.
 *  - cancelling: a cancel was requested but has not confirmed (e.g. the user
 *    declined the soft-cancel signature). Kept here so a REJECTED batch-cancel
 *    leaves the legs retryable in-session rather than stranded.
 * A filled / cancelled / expired / failed leg is terminal and never re-touched.
 */
export const CANCELLABLE_LEG_STATUSES: readonly BasketLegStatus[] = ['open', 'signing', 'cancelling']

/** A single composed leg with its quote-derived amounts and live status. */
export interface BasketLeg extends DecomposedLeg {
  /** 1-based position within the basket (matches the appData ophisBasket.leg). */
  readonly leg: number
  /** Minimum buy amount in atoms (slippage-adjusted quote out); undefined until quoted. */
  buyAmount?: string
  status: BasketLegStatus
  orderUid?: string
  error?: string
}

/** A composed, decomposed, ready-to-review basket. */
export interface BasketDraft {
  /** 32-hex basket id shared by every leg's appData ophisBasket.id. */
  readonly id: string
  /** The account that composed this basket. Placement/cancel guard against the
   *  CURRENT account so a wallet switch cannot act on a stale basket. */
  readonly owner: string
  readonly chainId: number
  /** Shared order deadline (unix seconds); every leg signs the same validTo. */
  readonly validTo: number
  readonly tier: BasketTier
  readonly legs: BasketLeg[]
}

/** Quote state for one leg, keyed while fanning out. */
export interface BasketLegQuote {
  readonly sellIndex: number
  readonly buyIndex: number
  /** Quoted buy amount in atoms (before slippage), or null while loading/failed. */
  buyAmount: string | null
  isLoading: boolean
  error?: string
}
