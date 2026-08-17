import { assertOphisBasketId, MAX_BASKET_LEGS, OphisBasketTag } from 'ophis/basketMetadata'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function hasValidBasketId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    assertOphisBasketId(value)
    return true
  } catch {
    return false
  }
}

function getValidPosition(leg: unknown, legs: unknown): { leg: number; legs: number } | null {
  const isValid =
    typeof leg === 'number' &&
    typeof legs === 'number' &&
    Number.isInteger(leg) &&
    Number.isInteger(legs) &&
    legs >= 1 &&
    legs <= MAX_BASKET_LEGS &&
    leg >= 1 &&
    leg <= legs
  return isValid ? { leg, legs } : null
}

/**
 * Read the `metadata.ophisBasket` marker off a parsed order appData doc, or null
 * when the order is not a basket leg. Defensive: appData is attacker-shaped, so a
 * marker with a malformed id or an out-of-range leg/legs pair is treated as
 * absent (returns null) rather than trusted. The orders table uses this to group
 * legs and render the Basket badge.
 */
export function readBasketTag(appData: unknown): OphisBasketTag | null {
  const appDataRecord = asRecord(appData)
  const metadata = asRecord(appDataRecord?.metadata)
  const raw = asRecord(metadata?.ophisBasket)
  if (!raw) return null
  const { id, leg, legs } = raw
  const position = getValidPosition(leg, legs)
  if (!hasValidBasketId(id) || !position) return null
  return { id, ...position }
}
