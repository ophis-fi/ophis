import { BasketDraft, BasketLeg } from '../types'

/**
 * True when a leg has a validated quote: a non-empty min-buy amount (atoms).
 * A leg still loading or whose quote failed has `buyAmount` undefined, so it
 * reads as not-yet-quoted.
 */
export function isLegQuoted(leg: Pick<BasketLeg, 'buyAmount'>): boolean {
  return typeof leg.buyAmount === 'string' && leg.buyAmount.length > 0
}

/** True when EVERY leg of the basket has a validated quote. */
export function allLegsQuoted(legs: readonly Pick<BasketLeg, 'buyAmount'>[]): boolean {
  return legs.length > 0 && legs.every(isLegQuoted)
}

/**
 * Gate for the "Place basket" confirm action: never while a placement is
 * running, and only once every leg has a validated quote (a defined min-buy).
 * This prevents starting the sequential loop with undefined buyAmounts, which
 * would sign legs with no min-out and expose a partial basket.
 */
export function canConfirmBasket(draft: BasketDraft | null, isPlacing: boolean): boolean {
  if (!draft || isPlacing) return false
  return allLegsQuoted(draft.legs)
}
