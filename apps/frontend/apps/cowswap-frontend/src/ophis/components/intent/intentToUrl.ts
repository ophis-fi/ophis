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
 */
import type { ParsedIntent } from './types'
import { chainSlugToId } from './chainMap'

export function intentToUrl(parsed: ParsedIntent): string {
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

  if (sell || buy) {
    segments.push(sell ?? '_')
    if (buy) segments.push(buy)
  }

  return '/' + segments.join('/')
}
