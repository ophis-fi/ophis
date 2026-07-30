/**
 * Basket (multi-order) attribution via order appData.
 *
 * Phase A of Ophis basket-intents ("ophis-multi-order") is a CLEAN-ROOM,
 * NO-CONTRACTS flow: a user composes N sell tokens x M buy tokens on one review
 * screen, and the frontend DECOMPOSES that into up to 6 single-pair GPv2 legs
 * that share one `validTo` and one basket `id`. Each leg is an ordinary CoW
 * order; the only thing binding them together is a marker embedded in each
 * leg's appData under `metadata.ophisBasket`:
 *
 *   metadata.ophisBasket = { id, leg, legs }
 *
 * where `id` is shared by every leg of one basket, `leg` is this leg's 1-based
 * index and `legs` is the basket's total leg count. This is what lets the
 * orders table group the legs under one badge, the status view show per-leg
 * fill state, the one-click "cancel unfilled legs" action find the siblings,
 * and the rebate indexer's `basket_id` passthrough column attribute basket
 * volume. It is NOT a settlement primitive: the legs are NEVER atomic (that is
 * Phase B / OphisBasketSettler). The marker is analytics + client-side grouping
 * only; serde ignores it on the backend as an unknown metadata key.
 *
 * The `id` grammar and the leg/product caps MUST match the frontend mirror
 * (apps/frontend/apps/cowswap-frontend/src/ophis/basketMetadata.ts) and the CI
 * gate (scripts/check-basket-metadata-invariant.sh) so a marker built here
 * groups exactly the rows the indexer and frontend recognise. Change one, change
 * all three in the same PR.
 */

/**
 * Basket id grammar: 32 lowercase hex chars (128 bits of randomness). Opaque,
 * DB-safe, collision-resistant, and case-insensitive-free (already lowercased)
 * so it round-trips through appData -> the indexer `basket_id` text column
 * without normalization surprises. Mirror this regex in the frontend
 * basketMetadata.ts and the invariant script.
 */
export const OPHIS_BASKET_ID_RE = /^[0-9a-f]{32}$/;

/**
 * Composition caps (owner decision 39: "6x6 product cap, API schema no wider
 * for v1"). At most 6 distinct sell tokens and 6 distinct buy tokens may be
 * composed into one basket.
 */
export const MAX_BASKET_SELL_TOKENS = 6;
export const MAX_BASKET_BUY_TOKENS = 6;

/**
 * Leg cap (spec 4.10: "decomposed into up to 6 single-pair GPv2 legs"). A
 * basket decomposes into at least 1 and at most 6 single-pair legs. This is the
 * hard cap the marker enforces; the frontend decomposition never emits more.
 */
export const MAX_BASKET_LEGS = 6;

/**
 * The marker embedded in each leg's appData under `metadata.ophisBasket`.
 * `id` is shared across all legs of one basket; `leg` is this leg's 1-based
 * position (1..legs); `legs` is the basket's total leg count (1..MAX_BASKET_LEGS).
 */
export interface OphisBasketTag {
  readonly id: string;
  readonly leg: number;
  readonly legs: number;
}

/**
 * Validate a basket id against the shared grammar. Throws on anything that
 * cannot round-trip through appData and the indexer column, so a malformed id
 * fails loudly at build time instead of silently producing an ungroupable leg.
 * Returns the id unchanged (already lowercase hex) on success.
 */
export function assertOphisBasketId(id: string): string {
  if (typeof id !== 'string' || !OPHIS_BASKET_ID_RE.test(id)) {
    throw new Error(
      'Invalid Ophis basket id: must be 32 lowercase hex chars (128 bits). ' +
        'Use newOphisBasketId() to mint one.',
    );
  }
  return id;
}

/**
 * Mint a fresh basket id: 16 random bytes rendered as 32 lowercase hex chars.
 *
 * Randomness is INJECTABLE (default `globalThis.crypto.getRandomValues`) so the
 * SDK stays dependency-free and the generator is deterministic under test. Pass
 * a `randomBytes` that returns at least 16 bytes; the first 16 are used.
 */
export function newOphisBasketId(randomBytes?: (n: number) => Uint8Array): string {
  const gen = randomBytes ?? defaultRandomBytes;
  const bytes = gen(16);
  if (!(bytes instanceof Uint8Array) || bytes.length < 16) {
    throw new Error('newOphisBasketId: randomBytes must return at least 16 bytes.');
  }
  let out = '';
  // for..of over a Uint8Array yields `number` (not number | undefined), so this
  // stays clean under noUncheckedIndexedAccess.
  for (const b of bytes.subarray(0, 16)) out += b.toString(16).padStart(2, '0');
  return out;
}

function defaultRandomBytes(n: number): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error(
      'newOphisBasketId: no crypto.getRandomValues in this runtime; pass a randomBytes source.',
    );
  }
  return c.getRandomValues(new Uint8Array(n));
}

/**
 * Assert that a (leg, legs) pair is internally consistent and within the cap:
 * integers, 1 <= leg <= legs <= MAX_BASKET_LEGS. Throws otherwise.
 */
export function assertOphisBasketLegs(leg: number, legs: number): void {
  if (!Number.isInteger(legs) || legs < 1 || legs > MAX_BASKET_LEGS) {
    throw new Error(
      `Invalid Ophis basket: legs must be an integer in [1, ${MAX_BASKET_LEGS}], got ${legs}.`,
    );
  }
  if (!Number.isInteger(leg) || leg < 1 || leg > legs) {
    throw new Error(`Invalid Ophis basket: leg must be an integer in [1, ${legs}], got ${leg}.`);
  }
}

/**
 * Build the appData metadata fragment that tags one leg with its basket marker.
 * Merge the returned object into that leg's appData `metadata`:
 *
 *   const metadata = { ...otherMetadata, ...buildOphisBasketMetadata(tag) }
 *
 * which yields `metadata.ophisBasket === { id, leg, legs }`.
 *
 * UNLIKE the referral tag, the marker is MANDATORY on every leg of a basket
 * (grouping, per-leg status and cancel-unfilled all depend on it), so this
 * always returns the marker and validates strictly rather than returning `{}`.
 */
export function buildOphisBasketMetadata(tag: OphisBasketTag): { ophisBasket: OphisBasketTag } {
  assertOphisBasketId(tag.id);
  assertOphisBasketLegs(tag.leg, tag.legs);
  return { ophisBasket: { id: tag.id, leg: tag.leg, legs: tag.legs } };
}
