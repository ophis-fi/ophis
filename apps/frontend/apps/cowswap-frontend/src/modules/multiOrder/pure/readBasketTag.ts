import { assertOphisBasketId, MAX_BASKET_LEGS, OphisBasketTag } from 'ophis/basketMetadata'

/**
 * Read the `metadata.ophisBasket` marker off a parsed order appData doc, or null
 * when the order is not a basket leg. Defensive: appData is attacker-shaped, so a
 * marker with a malformed id or an out-of-range leg/legs pair is treated as
 * absent (returns null) rather than trusted. The orders table uses this to group
 * legs and render the Basket badge.
 */
export function readBasketTag(appData: unknown): OphisBasketTag | null {
  if (!appData || typeof appData !== 'object') return null
  const metadata = (appData as { metadata?: unknown }).metadata
  if (!metadata || typeof metadata !== 'object') return null
  const raw = (metadata as { ophisBasket?: unknown }).ophisBasket
  if (!raw || typeof raw !== 'object') return null
  const { id, leg, legs } = raw as { id?: unknown; leg?: unknown; legs?: unknown }
  if (typeof id !== 'string') return null
  try {
    assertOphisBasketId(id)
  } catch {
    return null
  }
  if (
    typeof leg !== 'number' ||
    typeof legs !== 'number' ||
    !Number.isInteger(leg) ||
    !Number.isInteger(legs) ||
    legs < 1 ||
    legs > MAX_BASKET_LEGS ||
    leg < 1 ||
    leg > legs
  ) {
    return null
  }
  return { id, leg, legs }
}
