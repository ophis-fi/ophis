/**
 * Sequential basket placement with abort-and-cancel.
 *
 * The default (stepped) tier places each leg with its own EIP-712 signature, in
 * order. If the user aborts (closes the wallet, clicks cancel) or a leg's
 * signature/submit fails, we STOP and cancel the legs already placed but not yet
 * filled, so a half-placed basket does not leave stray open orders resting. This
 * is the automatic side of the mandatory "one-click cancel of unfilled legs":
 * the same cancel path is also exposed as a manual action in the status view.
 *
 * Because the legs are independent CoW orders (Phase A has no atomic settler),
 * an early leg can fill before a later leg is even signed. Cancellation targets
 * only still-open legs; a leg the caller reports as already filled is left
 * alone (its proceeds are the user's). Pure orchestration: the caller injects
 * `placeLeg` (sign + submit one leg) and `cancelLegs` (soft-cancel open legs).
 */

/** A minimal abort signal: only the boolean is read (AbortSignal satisfies it). */
export interface AbortLike {
  readonly aborted: boolean
}

export interface PlacedLeg<L> {
  readonly leg: L
  readonly orderUid: string
}

export interface RunBasketPlacementParams<L> {
  readonly legs: readonly L[]
  /** Sign + submit ONE leg; resolves with its order uid. Rejects on user reject / error. */
  readonly placeLeg: (leg: L, index: number) => Promise<string>
  /** Soft-cancel the already-placed, still-open legs (abort-and-cancel). */
  readonly cancelLegs: (placed: readonly PlacedLeg<L>[]) => Promise<void>
  /** Abort flag, checked before each leg (AbortSignal or a plain { aborted }). */
  readonly signal?: AbortLike
  readonly onLegPlaced?: (placed: PlacedLeg<L>, index: number) => void
  readonly onLegFailed?: (leg: L, index: number, error: unknown) => void
}

export interface BasketPlacementResult<L> {
  readonly placed: PlacedLeg<L>[]
  /** True if the user aborted before all legs were placed. */
  readonly aborted: boolean
  /** Index of the leg whose placement threw, if any. */
  readonly failedAt?: number
  /** True if abort/failure triggered cancellation of the already-placed legs. */
  readonly cancelled: boolean
  readonly error?: unknown
}

export async function runBasketPlacement<L>(params: RunBasketPlacementParams<L>): Promise<BasketPlacementResult<L>> {
  const { legs, placeLeg, cancelLegs, signal, onLegPlaced, onLegFailed } = params
  const placed: PlacedLeg<L>[] = []

  const cancelPlaced = async (): Promise<boolean> => {
    if (placed.length === 0) return false
    // Never let a cancellation failure mask the original abort/error.
    await cancelLegs(placed).catch(() => undefined)
    return true
  }

  for (const [i, leg] of legs.entries()) {
    if (signal?.aborted) {
      const cancelled = await cancelPlaced()
      return { placed, aborted: true, cancelled }
    }
    try {
      const orderUid = await placeLeg(leg, i)
      const record: PlacedLeg<L> = { leg, orderUid }
      placed.push(record)
      onLegPlaced?.(record, i)
    } catch (error) {
      onLegFailed?.(leg, i, error)
      const cancelled = await cancelPlaced()
      return { placed, aborted: false, failedAt: i, cancelled, error }
    }
  }

  // A late abort (flag flipped after the last placeLeg resolved) still cancels.
  if (signal?.aborted) {
    const cancelled = await cancelPlaced()
    return { placed, aborted: true, cancelled }
  }

  return { placed, aborted: false, cancelled: false }
}
