import { assertOphisBasketId, assertOphisBasketLegs, OphisBasketTag } from 'ophis/basketMetadata'

import { BasketDraft, BasketLeg } from '../types'

/**
 * The per-leg basket marker for one leg: { id (shared), leg (1-based), legs
 * (total) }. This is the value that MUST be merged into the leg's appData under
 * metadata.ophisBasket, or the whole feature is inert (the indexer basket_id
 * stays null and the orders-table badge cannot group the legs). Validates via
 * the shared grammar/cap asserts so a malformed draft fails loudly.
 */
export function basketLegMarker(draft: BasketDraft, leg: BasketLeg): OphisBasketTag {
  const legs = draft.legs.length
  assertOphisBasketId(draft.id)
  assertOphisBasketLegs(leg.leg, legs)
  return { id: draft.id, leg: leg.leg, legs }
}

/** Every leg of a basket paired with its marker (leg 1..legs), for the per-leg
 *  appData build. Guarantees each leg gets a DISTINCT { id, leg, legs }. */
export function basketLegMarkers(draft: BasketDraft): { leg: BasketLeg; marker: OphisBasketTag }[] {
  return draft.legs.map((leg) => ({ leg, marker: basketLegMarker(draft, leg) }))
}

/**
 * Build one leg's appData by merging its basket marker into the base appData
 * params and delegating to the injected `buildFn` (the real
 * `modules/appData/utils/buildAppData` in the app; a spy under test). The marker
 * lands at `params.ophisBasket`, which `buildAppData` spreads into
 * `metadata.ophisBasket`, so the returned/ submitted appData carries
 * { id, leg, legs }. Injecting `buildFn` keeps this unit-testable without the
 * cow-sdk metadata pipeline.
 */
export async function buildBasketLegAppData<P extends object, R>(
  buildFn: (params: P & { ophisBasket: OphisBasketTag }) => Promise<R>,
  baseParams: P,
  draft: BasketDraft,
  leg: BasketLeg,
): Promise<R> {
  return buildFn({ ...baseParams, ophisBasket: basketLegMarker(draft, leg) })
}
