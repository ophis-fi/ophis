/**
 * Build a cowswap hash-route URL from a ParsedIntent.
 *
 * Cowswap routes use path segments, not query strings:
 *   /:chainId?/swap/:inputCurrencyId?/:outputCurrencyId?
 * with `_` as the placeholder when inputCurrency is missing but
 * outputCurrency is set.
 *
 * V1 intentionally does not pre-fill amount: cowswap's `sellAmount`
 * query expects atomic units (per-token decimals), which this layer
 * doesn't know without a token-list lookup. The user types the amount
 * on the swap screen.
 *
 * `resolveToken` (optional) rewrites a recognised token SYMBOL to an on-chain
 * ADDRESS for the URL's target chain. Emitting an address (vs the bare symbol)
 * is what makes the swap form fill reliably: an address resolves
 * checksum-insensitively and bypasses the ambiguous-symbol reset
 * (useResetStateWithSymbolDuplication short-circuits on isAddress), so two
 * different tokens sharing a symbol no longer open an empty form. When the
 * resolver returns null (symbol unknown on that chain, or its list isn't
 * loaded) we fall back to the bare symbol exactly as before, so the URL is
 * always valid and never worse than the symbol-only behaviour.
 */
import type { ParsedIntent } from './types'
import { chainSlugToId } from './chainMap'

export function intentToUrl(parsed: ParsedIntent, resolveToken?: (symbol: string) => string | null): string {
  if (parsed.intent !== 'swap') return '/swap'

  let chainId: number | undefined
  let sell: string | undefined
  let buy: string | undefined

  for (const e of parsed.entities) {
    if (e.type === 'chain' && chainId === undefined) chainId = chainSlugToId(e.value)
    else if (e.type === 'sellToken' && sell === undefined) sell = e.value
    else if (e.type === 'buyToken' && buy === undefined) buy = e.value
  }

  const segments: string[] = []
  if (chainId !== undefined) segments.push(String(chainId))
  segments.push('swap')

  // Encode token segments: valid symbols/addresses are unaffected, but a
  // malformed parser value (containing `/`, `?`, `#`, …) can't alter the route.
  const toSegment = (symbol: string): string => encodeURIComponent(resolveToken?.(symbol) ?? symbol)

  if (sell || buy) {
    segments.push(sell ? toSegment(sell) : '_')
    if (buy) segments.push(toSegment(buy))
  }

  return '/' + segments.join('/')
}
