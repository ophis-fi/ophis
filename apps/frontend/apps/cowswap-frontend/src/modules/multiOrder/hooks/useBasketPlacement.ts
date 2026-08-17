import { useSetAtom } from 'jotai'
import { useAtomCallback } from 'jotai/utils'
import { useCallback, useRef, useState } from 'react'

import { assertTradeTokenPolicy } from '@cowprotocol/tokens'

import { OphisBasketTag } from 'ophis/basketMetadata'

import type { AppDataInfo } from 'modules/appData'

import { basketLegMarker } from '../pure/basketLegAppData'
import { CancelCandidate, runLegCancellation } from '../pure/cancellation'
import { isDraftForContext } from '../pure/draftContext'
import { PlacedLeg, runBasketPlacement } from '../pure/placement'
import { basketDraftAtom, updateBasketLegAtom } from '../state/multiOrder.atoms'
import { BasketDraft, BasketLeg } from '../types'

/** Build ONE leg's appData with its basket marker merged (metadata.ophisBasket).
 *  Supplied by the container (useBuildBasketLegAppData). This is what makes the
 *  ophisBasket chain functional: every placed leg's appData carries { id, leg, legs }. */
export type BuildBasketLegAppDataFn = (leg: BasketLeg, marker: OphisBasketTag) => Promise<AppDataInfo>

/** Sign + submit ONE leg using the per-leg appData (which carries the basket
 *  marker); resolves with its order uid. Injected by the container (wires
 *  tradeQuote.postSwapOrderFromQuote / the presign path per tier). */
export type PlaceBasketLegFn = (leg: BasketLeg, index: number, appData: AppDataInfo) => Promise<string>

/** Soft-cancel a set of placed, still-open legs. Injected by the container
 *  (wires the CoW soft-cancel / DELETE order path). Rejects if the user declines. */
export type CancelBasketLegsFn = (placed: readonly PlacedLeg<BasketLeg>[]) => Promise<void>

/** Current wallet context, used to guard place/cancel against a basket that was
 *  composed under a different account/chain. */
export interface BasketPlacementContext {
  readonly owner: string | undefined
  readonly chainId: number | undefined
}

export interface UseBasketPlacementResult {
  readonly isPlacing: boolean
  /** Place every leg sequentially (stepped tier). Aborting or a leg failure
   *  cancels the already-placed, still-open legs. No-op if the draft belongs to
   *  a different wallet context. */
  readonly place: () => Promise<void>
  /** Abort an in-flight placement (triggers cancel-and-abort). */
  readonly abort: () => void
  /** Manual one-click cancel of every still-open (unfilled) leg. */
  readonly cancelUnfilled: () => Promise<void>
}

function assertBasketTokenPolicy(draft: BasketDraft): void {
  for (const leg of draft.legs) {
    assertTradeTokenPolicy(
      { chainId: draft.chainId, address: leg.sellToken },
      { chainId: draft.chainId, address: leg.buyToken },
    )
  }
}

/**
 * Orchestrate stepped basket placement. The sequencing + abort-and-cancel logic
 * (pure/placement.ts), the status-aware cancellation (pure/cancellation.ts), and
 * the per-leg marker (pure/basketLegAppData.ts) are all pure and unit tested;
 * this hook binds them to the per-leg status atoms.
 *
 * Every leg's appData is built HERE with its basket marker (basketLegMarker ->
 * buildLegAppData) and passed to the injected submit, so the marker cannot be
 * forgotten by a call site and each submitted leg carries metadata.ophisBasket.
 *
 * Placement and cancellation are guarded by isDraftForContext, so a wallet or
 * chain switch cannot place or cancel a basket composed under a different
 * account/chain (which the reset updater also clears).
 *
 * Cancellation consults LIVE leg status (never stale snapshots), so a leg that
 * filled mid-placement is never mislabelled cancelled, and a rejected soft-cancel
 * leaves legs at 'cancelling' (retryable).
 */
export function useBasketPlacement(
  draft: BasketDraft | null,
  context: BasketPlacementContext,
  buildLegAppData: BuildBasketLegAppDataFn,
  placeLeg: PlaceBasketLegFn,
  cancelLegs: CancelBasketLegsFn,
): UseBasketPlacementResult {
  const updateLeg = useSetAtom(updateBasketLegAtom)
  const [isPlacing, setIsPlacing] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const { owner, chainId } = context

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
    // Never place a basket composed under a different account/chain.
    if (!isDraftForContext(draft, owner, chainId)) return
    assertBasketTokenPolicy(draft)
    const controller = new AbortController()
    abortRef.current = controller
    setIsPlacing(true)
    try {
      await runBasketPlacement<BasketLeg>({
        legs: draft.legs,
        signal: controller.signal,
        placeLeg: async (leg, index) => {
          updateLeg({ leg: leg.leg, patch: { status: 'signing' } })
          // Build this leg's appData WITH its basket marker, then submit it.
          const marker = basketLegMarker(draft, leg)
          const appData = await buildLegAppData(leg, marker)
          const orderUid = await placeLeg(leg, index, appData)
          updateLeg({ leg: leg.leg, patch: { status: 'open', orderUid } })
          return orderUid
        },
        // Status-aware: skips legs that filled mid-placement; leaves legs at
        // 'cancelling' (retryable) if the soft-cancel is rejected.
        cancelLegs: (placed) => cancelWithStatus(placed.map((p) => ({ leg: p.leg.leg, orderUid: p.orderUid }))),
        onLegFailed: (leg, _index, error) =>
          updateLeg({
            leg: leg.leg,
            patch: { status: 'failed', error: error instanceof Error ? error.message : String(error) },
          }),
      })
    } finally {
      setIsPlacing(false)
      abortRef.current = null
    }
  }, [draft, owner, chainId, buildLegAppData, placeLeg, cancelWithStatus, updateLeg])

  const abort = useCallback(() => abortRef.current?.abort(), [])

  // Manual retry: cancel every still-cancellable placed leg, reading fresh state.
  const cancelUnfilled = useAtomCallback(
    useCallback(
      async (get): Promise<void> => {
        const current = get(basketDraftAtom)
        if (!current) return
        // Only the composing account/chain can cancel (it holds the signing key).
        if (!isDraftForContext(current, owner, chainId)) return
        const candidates: CancelCandidate[] = current.legs
          .filter((l): l is BasketLeg & { orderUid: string } => Boolean(l.orderUid))
          .map((l) => ({ leg: l.leg, orderUid: l.orderUid }))
        if (candidates.length === 0) return
        await cancelWithStatus(candidates)
      },
      [cancelWithStatus, owner, chainId],
    ),
  )

  return { isPlacing, place, abort, cancelUnfilled }
}
