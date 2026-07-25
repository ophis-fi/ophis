import { useCallback, useRef, useState } from 'react'

import { useAtomValue, useSetAtom } from 'jotai'

import { cancellableBasketLegsAtom, updateBasketLegAtom } from '../state/multiOrder.atoms'
import { BasketDraft, BasketLeg } from '../types'
import { PlacedLeg, runBasketPlacement } from '../pure/placement'

/** Sign + submit ONE leg; resolves with its order uid. Injected by the container
 *  (wires tradeQuote.postSwapOrderFromQuote / the presign path per tier). */
export type PlaceBasketLegFn = (leg: BasketLeg, index: number) => Promise<string>

/** Soft-cancel a set of placed, still-open legs. Injected by the container
 *  (wires the CoW soft-cancel / DELETE order path). */
export type CancelBasketLegsFn = (placed: readonly PlacedLeg<BasketLeg>[]) => Promise<void>

export interface UseBasketPlacementResult {
  readonly isPlacing: boolean
  /** Place every leg sequentially (stepped tier). Aborting or a leg failure
   *  cancels the already-placed, still-open legs. */
  readonly place: () => Promise<void>
  /** Abort an in-flight placement (triggers cancel-and-abort). */
  readonly abort: () => void
  /** Manual one-click cancel of every still-open (unfilled) leg. */
  readonly cancelUnfilled: () => Promise<void>
}

/**
 * Orchestrate stepped basket placement. The sequencing + abort-and-cancel logic
 * is pure (pure/placement.ts, unit tested); this hook binds it to the per-leg
 * status atoms and exposes the mandatory manual cancel-of-unfilled action.
 */
export function useBasketPlacement(
  draft: BasketDraft | null,
  placeLeg: PlaceBasketLegFn,
  cancelLegs: CancelBasketLegsFn,
): UseBasketPlacementResult {
  const updateLeg = useSetAtom(updateBasketLegAtom)
  const cancellableLegs = useAtomValue(cancellableBasketLegsAtom)
  const [isPlacing, setIsPlacing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const place = useCallback(async () => {
    if (!draft) return
    const controller = new AbortController()
    abortRef.current = controller
    setIsPlacing(true)
    try {
      await runBasketPlacement<BasketLeg>({
        legs: draft.legs,
        signal: controller.signal,
        placeLeg: async (leg, index) => {
          updateLeg({ leg: leg.leg, patch: { status: 'signing' } })
          const orderUid = await placeLeg(leg, index)
          updateLeg({ leg: leg.leg, patch: { status: 'open', orderUid } })
          return orderUid
        },
        cancelLegs: async (placed) => {
          for (const p of placed) updateLeg({ leg: p.leg.leg, patch: { status: 'cancelling' } })
          await cancelLegs(placed)
          for (const p of placed) updateLeg({ leg: p.leg.leg, patch: { status: 'cancelled' } })
        },
        onLegFailed: (leg, _index, error) =>
          updateLeg({ leg: leg.leg, patch: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }),
      })
    } finally {
      setIsPlacing(false)
      abortRef.current = null
    }
  }, [draft, placeLeg, cancelLegs, updateLeg])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  const cancelUnfilled = useCallback(async () => {
    if (cancellableLegs.length === 0) return
    const placed: PlacedLeg<BasketLeg>[] = cancellableLegs
      .filter((l): l is BasketLeg & { orderUid: string } => Boolean(l.orderUid))
      .map((l) => ({ leg: l, orderUid: l.orderUid }))
    if (placed.length === 0) return
    for (const p of placed) updateLeg({ leg: p.leg.leg, patch: { status: 'cancelling' } })
    await cancelLegs(placed)
    for (const p of placed) updateLeg({ leg: p.leg.leg, patch: { status: 'cancelled' } })
  }, [cancellableLegs, cancelLegs, updateLeg])

  return { isPlacing, place, abort, cancelUnfilled }
}
