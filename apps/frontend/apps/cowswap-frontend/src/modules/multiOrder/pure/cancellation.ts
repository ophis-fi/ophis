/**
 * Status-aware basket-leg cancellation.
 *
 * Both the automatic abort-and-cancel path and the manual "cancel unfilled legs"
 * action route through here. Two correctness rules the naive "mark everything
 * cancelled" version got wrong:
 *
 *  1. NEVER mark a filled leg cancelled. The legs are independent CoW orders, so
 *     an early leg can fill during the placement window. A filled CoW order
 *     cannot be cancelled on-chain, and showing it as cancelled would be a
 *     display lie. We consult LIVE status and skip any leg that is not currently
 *     cancellable.
 *  2. A REJECTED cancel must stay retryable in-session. If the soft-cancel
 *     signature is declined (or the request fails), the touched legs are left at
 *     'cancelling' (which is a cancellable status), so the manual retry action
 *     re-enables for them rather than stranding them.
 *
 * Pure: the live-status read, the status write, and the actual cancel call are
 * all injected, so this is unit-tested without jotai or a wallet.
 */
import { BasketLegStatus, CANCELLABLE_LEG_STATUSES } from '../types'

/** True for a status at which a leg can (still) be cancelled: open, mid-signing,
 *  or stuck mid-cancel after a rejected cancel. */
export function isCancellableStatus(status: BasketLegStatus): boolean {
  return CANCELLABLE_LEG_STATUSES.includes(status)
}

export interface CancelCandidate {
  readonly leg: number
  readonly orderUid: string
}

export interface LegCancellationResult {
  /** Legs actually attempted (cancellable at the time of the call). */
  readonly attempted: number[]
  /** Legs confirmed cancelled (were still 'cancelling' after a successful cancel). */
  readonly cancelled: number[]
}

export async function runLegCancellation(params: {
  readonly candidates: readonly CancelCandidate[]
  readonly getStatus: (leg: number) => BasketLegStatus | undefined
  readonly setStatus: (leg: number, status: BasketLegStatus) => void
  readonly cancel: (legs: CancelCandidate[]) => Promise<void>
}): Promise<LegCancellationResult> {
  const { candidates, getStatus, setStatus, cancel } = params

  // Rule 1: only touch legs whose LIVE status is still cancellable. A filled (or
  // otherwise terminal) leg is skipped entirely and never re-labelled.
  const toCancel = candidates.filter((c) => {
    const s = getStatus(c.leg)
    return s !== undefined && isCancellableStatus(s)
  })
  if (toCancel.length === 0) return { attempted: [], cancelled: [] }

  for (const c of toCancel) setStatus(c.leg, 'cancelling')
  const attempted = toCancel.map((c) => c.leg)

  try {
    await cancel([...toCancel])
  } catch {
    // Rule 2: cancel rejected/failed. Leave the legs at 'cancelling' so the manual
    // retry action stays enabled for them. Do NOT mark them cancelled.
    return { attempted, cancelled: [] }
  }

  // Success: mark cancelled ONLY the legs still 'cancelling'. A leg that filled
  // during the cancel round-trip stays filled (its proceeds are the user's).
  const cancelled: number[] = []
  for (const c of toCancel) {
    if (getStatus(c.leg) === 'cancelling') {
      setStatus(c.leg, 'cancelled')
      cancelled.push(c.leg)
    }
  }
  return { attempted, cancelled }
}
