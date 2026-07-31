/**
 * Ophis basket (multi-order) appData marker.
 *
 * MIRROR of packages/sdk/src/basket-metadata.ts.
 *
 * The cowswap fork lives in its own pnpm workspace and cannot import from the
 * outer monorepo (@ophis/sdk is not in this workspace's node_modules). We
 * duplicate the marker builder + grammar + caps here following the same pattern
 * as partnerFeeDefault.ts / tiers.ts.
 *
 * Any time the basket id grammar or the caps change, change ALL THREE places in
 * the same PR (scripts/check-basket-metadata-invariant.sh is the hard CI gate):
 *   1. packages/sdk/src/basket-metadata.ts             (source of truth)
 *   2. apps/frontend/.../src/ophis/basketMetadata.ts   (this file, frontend mirror)
 *   3. scripts/check-basket-metadata-invariant.sh      (pins 1 == 2)
 *
 * Phase A ("ophis-multi-order") is a CLEAN-ROOM, NO-CONTRACTS flow: a user
 * composes N sell x M buy on one review screen, and the frontend decomposes it
 * into up to 6 single-pair GPv2 legs that share one `validTo` and one basket
 * `id`. Each leg is an ordinary CoW order; the marker
 * `metadata.ophisBasket = { id, leg, legs }` embedded in each leg's appData is
 * the ONLY thing binding them together. It drives the orders-table grouping
 * badge, per-leg status, one-click cancel-of-unfilled, and the rebate indexer's
 * `basket_id` passthrough. It is NEVER a settlement primitive: the legs are not
 * atomic (that is Phase B / OphisBasketSettler).
 */

/** Basket id grammar: 32 lowercase hex chars (128 bits). Mirror of the SDK. */
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/

/** Composition caps (owner decision 39: 6x6 product cap, API schema no wider for v1). */
export const MAX_BASKET_SELL_TOKENS = 6
export const MAX_BASKET_BUY_TOKENS = 6

/** Leg cap (spec 4.10: "decomposed into up to 6 single-pair GPv2 legs"). */
export const MAX_BASKET_LEGS = 6

/** The marker embedded in each leg's appData under `metadata.ophisBasket`. */
export interface OphisBasketTag {
  readonly id: string
  readonly leg: number
  readonly legs: number
}

/** Validate a basket id against the shared grammar; throws on a value that cannot
 *  round-trip through appData and the indexer column. Returns the id on success. */
export function assertOphisBasketId(id: string): string {
  if (typeof id !== 'string' || !OPHIS_BASKET_ID_RE.test(id)) {
    throw new Error('Invalid Ophis basket id: must be 32 lowercase hex chars (128 bits).')
  }
  return id
}

/** Mint a fresh basket id: 16 random bytes as 32 lowercase hex chars. Randomness
 *  is injectable (default globalThis.crypto.getRandomValues) for testability. */
export function newOphisBasketId(randomBytes?: (n: number) => Uint8Array): string {
  const gen = randomBytes ?? defaultRandomBytes
  const bytes = gen(16)
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    throw new Error('newOphisBasketId: randomBytes must return at least 16 bytes.')
  }
  let out = ''
  for (const b of bytes.subarray(0, 16)) out += b.toString(16).padStart(2, '0')
  return out
}

function defaultRandomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('newOphisBasketId: no crypto.getRandomValues in this runtime; pass a randomBytes source.')
  }
  return c.getRandomValues(new Uint8Array(n))
}

/** Assert a (leg, legs) pair: integers, 1 <= leg <= legs <= MAX_BASKET_LEGS. */
export function assertOphisBasketLegs(leg: number, legs: number): void {
  if (!Number.isInteger(legs) || legs < 1 || legs > MAX_BASKET_LEGS) {
    throw new Error(`Invalid Ophis basket: legs must be an integer in [1, ${MAX_BASKET_LEGS}], got ${legs}.`)
  }
  if (!Number.isInteger(leg) || leg < 1 || leg > legs) {
    throw new Error(`Invalid Ophis basket: leg must be an integer in [1, ${legs}], got ${leg}.`)
  }
}

/**
 * Build the appData metadata fragment tagging one leg with its basket marker.
 * Merge into that leg's appData `metadata`:
 *
 *   metadata = { ...otherMetadata, ...buildOphisBasketMetadata(tag) }
 *
 * yielding `metadata.ophisBasket === { id, leg, legs }`. Unlike the referral
 * tag, the marker is MANDATORY on every leg, so this always returns it and
 * validates strictly.
 */
export function buildOphisBasketMetadata(tag: OphisBasketTag): { ophisBasket: OphisBasketTag } {
  assertOphisBasketId(tag.id)
  assertOphisBasketLegs(tag.leg, tag.legs)
  return { ophisBasket: { id: tag.id, leg: tag.leg, legs: tag.legs } }
}
