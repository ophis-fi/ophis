import { useCallback, useRef, useState } from 'react'

import { useSetAtom } from 'jotai'
import { useAtomCallback } from 'jotai/utils'

import { basketDraftAtom, updateBasketLegAtom } from '../state/multiOrder.atoms'
import { BasketDraft, BasketLeg } from '../types'
import { CancelCandidate, runLegCancellation } from '../pure/cancellation'
import { PlacedLeg, runBasketPlacement } from '../pure/placement'

/** Sign + submit ONE leg; resolves with its order uid. Injected by the container
 *  (wires tradeQuote.postSwapOrderFromQuote / the presign path per tier). */
export type PlaceBasketLegFn = (leg: BasketLeg, index: number) => Promise<string>

/** Soft-cancel a set of placed, still-open legs. Injected by the container
 *  (wires the CoW soft-cancel / DELETE order path). Rejects if the user declines. */
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
 * (pure/placement.ts) and the status-aware cancellation (pure/cancellation.ts)
 * are pure and unit tested; this hook binds them to the per-leg status atoms.
 *
 * Cancellation consults LIVE leg status via useAtomCallback rather than the
 * stale leg snapshots the sequencer captured at placement time, so:
 *  - a leg that FILLED during the placement window is never marked cancelled
 *    (a filled CoW order cannot be cancelled on-chain), and
 *  - a REJECTED soft-cancel leaves its legs at 'cancelling', which is a
 *    cancellable status, so the manual retry action re-enables for them.
 */
export function useBasketPlacement(
  draft: BasketDraft | null,
  placeLeg: PlaceBasketLegFn,
  cancelLegs: CancelBasketLegsFn,
): UseBasketPlacementResult {
  const updateLeg = useSetAtom(updateBasketLegAtom)
  const [isPlacing, setIsPlacing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Status-aware cancellation over the LIVE draft. Never rejects (runLegCancellation
  // handles its own errors), so the placement sequencer's cancel step is safe.
  const cancelWithStatus = useAtomCallback(
    useCallback(
      async (get, set, candidates: CancelCandidate[]): Promise<void> => {
        await runLegCancellation({
          candidates,
          getStatus: (leg) => get(basketDraftAtom)?.legs.find((l) => l.leg === leg)?.status,
          setStatus: (leg, status) => set(updateBasketLegAtom, { leg, patch: { status } }),
          cancel: async (legs) => {
            const current = get(basketDraftAtom)
            const placed: PlacedLeg<BasketLeg>[] = legs.flatMap((c) => {
              const live = current?.legs.find((l) => l.leg === c.leg)
              return live ? [{ leg: live, orderUid: c.orderUid }] : []
            })
            await cancelLegs(placed)
          },
        })
      },
      [cancelLegs],
    ),
  )

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
        // Status-aware: skips legs that filled mid-placement; leaves legs at
        // 'cancelling' (retryable) if the soft-cancel is rejected.
        cancelLegs: (placed) => cancelWithStatus(placed.map((p) => ({ leg: p.leg.leg, orderUid: p.orderUid }))),
        onLegFailed: (leg, _index, error) =>
          updateLeg({ leg: leg.leg, patch: { status: 'failed', error: error instanceof Error ? error.message : String(error) } }),
      })
    } finally {
      setIsPlacing(false)
      abortRef.current = null
    }
  }, [draft, placeLeg, cancelWithStatus, updateLeg])

  const abort = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Manual retry: cancel every still-cancellable placed leg, reading fresh state.
  const cancelUnfilled = useAtomCallback(
    useCallback(
      async (get): Promise<void> => {
        const current = get(basketDraftAtom)
        if (!current) return
        const candidates: CancelCandidate[] = current.legs
          .filter((l): l is BasketLeg & { orderUid: string } => Boolean(l.orderUid))
          .map((l) => ({ leg: l.leg, orderUid: l.orderUid }))
        if (candidates.length === 0) return
        await cancelWithStatus(candidates)
      },
      [cancelWithStatus],
    ),
  )

  return { isPlacing, place, abort, cancelUnfilled }
}
