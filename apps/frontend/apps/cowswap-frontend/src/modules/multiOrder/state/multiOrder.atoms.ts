import { atom } from 'jotai'

import { BasketDraft, BasketLeg, CANCELLABLE_LEG_STATUSES } from '../types'

/**
 * Raw composition the basket widget collects before decomposition: up to 6 sell
 * inputs (token + exact atom amount) and up to 6 buy outputs (token + relative
 * weight in basis points). `useBasketDecomposition` turns this into a draft.
 */
export interface BasketCompositionState {
  sells: { token: string; amount: string }[]
  buys: { token: string; weightBps: number }[]
}

const EMPTY_COMPOSITION: BasketCompositionState = { sells: [], buys: [] }

/** The widget form state. */
export const basketCompositionAtom = atom<BasketCompositionState>(EMPTY_COMPOSITION)

/**
 * The decomposed + quoted basket under review / in flight, or null when no
 * basket is active. Holds the shared id/validTo/tier and the per-leg live
 * status. Legs are keyed by their 1-based `leg` index for the update atom.
 */
export const basketDraftAtom = atom<BasketDraft | null>(null)

/** Reset everything (used on close / after a completed basket). */
export const resetBasketAtom = atom(null, (_get, set) => {
  set(basketCompositionAtom, EMPTY_COMPOSITION)
  set(basketDraftAtom, null)
})

export interface UpdateBasketLegParams {
  /** 1-based leg index. */
  leg: number
  patch: Partial<Pick<BasketLeg, 'status' | 'orderUid' | 'buyAmount' | 'error'>>
}

/**
 * Write-only atom: patch a single leg of the active basket by its 1-based index.
 * No-op when there is no active basket or the index is out of range. Mirrors the
 * per-order update pattern in orderProgressBar/state/atoms.ts.
 */
export const updateBasketLegAtom = atom(null, (get, set, { leg, patch }: UpdateBasketLegParams) => {
  const draft = get(basketDraftAtom)
  if (!draft) return
  const idx = draft.legs.findIndex((l) => l.leg === leg)
  if (idx === -1) return
  const nextLegs = draft.legs.slice()
  nextLegs[idx] = { ...nextLegs[idx], ...patch }
  set(basketDraftAtom, { ...draft, legs: nextLegs })
})

/** Derived: the still-cancellable (or retry-cancellable) legs of the active
 *  basket. Includes 'cancelling' so a rejected batch-cancel stays retryable. */
export const cancellableBasketLegsAtom = atom<BasketLeg[]>((get) => {
  const draft = get(basketDraftAtom)
  if (!draft) return []
  return draft.legs.filter((l) => CANCELLABLE_LEG_STATUSES.includes(l.status))
})
