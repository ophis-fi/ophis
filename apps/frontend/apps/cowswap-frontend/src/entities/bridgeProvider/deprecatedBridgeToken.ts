/**
 * NEAR Intents (the HOT omni-bridge, asset namespace `v2_1.omni.hot.tg`) is one
 * of the three bridge providers Ophis aggregates for cross-chain destination
 * tokens (alongside Bungee and Across). When a bridged route is superseded
 * (e.g. Plasma's native XPL and USDT0 after an omni-bridge route migration),
 * NEAR Intents keeps the old asset in its token list but appends a
 * "(DEPRECATED)" marker to the SYMBOL it serves, e.g. "XPL_(DEPRECATED)" and
 * "USDT0(DEPRECATED)". A current, non-deprecated entry for the same asset is
 * always present alongside it.
 *
 * That marker is a label curated by the aggregator. It is NOT an on-chain ERC-20
 * symbol (the real on-chain symbol is just "XPL"). Surfacing both the live token
 * and its "(DEPRECATED)" duplicate in the buy-token selector only confuses users
 * picking a destination asset, so we drop the deprecated duplicates here.
 *
 * Bungee and Across do not use this convention, so this predicate only ever
 * matches NEAR Intents entries. We match the PARENTHESIZED marker specifically
 * (not a bare "deprecated" substring) so a legitimately named token cannot be
 * hidden by accident.
 */
const DEPRECATED_MARKER = /\(\s*deprecated\s*\)/i

export function isDeprecatedBridgeToken(token: { symbol?: string | null; name?: string | null }): boolean {
  return DEPRECATED_MARKER.test(token.symbol || '') || DEPRECATED_MARKER.test(token.name || '')
}
