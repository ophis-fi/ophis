import { useCallback, useMemo } from 'react'

import { newOphisBasketId } from 'ophis/basketMetadata'

import { BasketCompositionState } from '../state/multiOrder.atoms'
import { BasketDraft, BasketLeg, BasketTier } from '../types'
import { BasketComposition, decomposeBasket, DecomposedLeg } from '../pure/decomposition'

const DEFAULT_VALID_FOR_SECONDS = 30 * 60 // 30 min; every leg shares this validTo

function toComposition(state: BasketCompositionState): BasketComposition {
  return {
    sells: state.sells.map((s) => ({ token: s.token, amount: s.amount })),
    buys: state.buys.map((b) => ({ token: b.token, weight: BigInt(b.weightBps) })),
  }
}

export interface UseBasketDecompositionResult {
  /** Live decomposition preview for the composer, recomputed on every edit.
   *  Null (with `error`) when the composition is incomplete or over a cap. */
  readonly legs: DecomposedLeg[] | null
  readonly error: string | null
  /** Snapshot the current composition into a signable draft: mints a fresh basket
   *  id, stamps a shared validTo, and assigns per-leg 1-based indices. Throws the
   *  same errors as the pure decomposer on an invalid composition. */
  readonly createDraft: (tier: BasketTier, validForSeconds?: number) => BasketDraft
}

/**
 * Decompose the composed basket into single-pair legs with remainder-exact
 * bigint math (see pure/decomposition.ts). The heavy lifting is pure and
 * unit-tested; this hook only wires it to the form state and mints the
 * basket-session id + shared validTo when the user commits to a draft.
 */
export function useBasketDecomposition(
  composition: BasketCompositionState,
  chainId: number,
): UseBasketDecompositionResult {
  const { legs, error } = useMemo(() => {
    // A composer that has not yet added at least one sell and one buy is simply
    // incomplete; surface no error, just no preview.
    if (composition.sells.length === 0 || composition.buys.length === 0) {
      return { legs: null, error: null }
    }
    try {
      return { legs: decomposeBasket(toComposition(composition)), error: null }
    } catch (e) {
      return { legs: null, error: e instanceof Error ? e.message : String(e) }
    }
  }, [composition])

  const createDraft = useCallback(
    (tier: BasketTier, validForSeconds = DEFAULT_VALID_FOR_SECONDS): BasketDraft => {
      const decomposed = decomposeBasket(toComposition(composition))
      const id = newOphisBasketId()
      const validTo = Math.floor(Date.now() / 1000) + validForSeconds
      const basketLegs: BasketLeg[] = decomposed.map((leg, i) => ({
        ...leg,
        leg: i + 1, // 1-based, matches appData ophisBasket.leg
        status: 'pending',
      }))
      return { id, chainId, validTo, tier, legs: basketLegs }
    },
    [composition, chainId],
  )

  return { legs, error, createDraft }
}
