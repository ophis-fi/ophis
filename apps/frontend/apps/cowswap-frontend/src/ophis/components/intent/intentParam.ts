/**
 * Read a prefill intent string from a URL query (the decode direction of
 * intentToUrl's encode).
 *
 * A shareable link like `swap.ophis.fi/?intent=swap 100 USDC for ETH` (or the
 * hash-router form `/#/?intent=...`) should land the visitor on the intent
 * landing with their request already typed in, so the parser fires on arrival
 * and Continue is enabled, one tap from a pre-filled trade. Social posts, docs
 * "try it" links, and agents can hand out such a link WITHOUT first resolving
 * tokens themselves (that resolution happens on the landing).
 *
 * Cowswap uses a hash router, so the query can sit in two places depending on
 * how the link was written: after the hash (`/#/?intent=...`, visible to
 * react-router's useSearchParams) or before it (`/?intent=...`, only in
 * document.location.search). Pass both and the first non-empty `intent` wins.
 *
 * The value only ever seeds a controlled textarea (React escapes it) and is
 * re-validated + length-capped server-side by the parser API, so there is no
 * injection surface here. We still trim and cap to the parser's own 280-char
 * limit so an over-long link can't inflate the request.
 */

// Mirrors the parser API's max input length (swap.ophis.fi/api/intent).
export const MAX_INTENT_PREFILL_LEN = 280

export function readIntentParam(...searches: Array<string | null | undefined>): string {
  for (const search of searches) {
    if (!search) continue
    const value = new URLSearchParams(search).get('intent')
    const trimmed = value?.trim()
    if (trimmed) return trimmed.slice(0, MAX_INTENT_PREFILL_LEN)
  }
  return ''
}
