/**
 * Build a cowswap hash-route URL from a ParsedIntent.
 *
 * Cowswap routes carry chain + tokens as PATH segments:
 *   /:chainId?/swap/:inputCurrencyId?/:outputCurrencyId?
 * with `_` as the placeholder when inputCurrency is missing but outputCurrency
 * is set. The AMOUNT rides in a query param (?sellAmount= / ?buyAmount=), which
 * cowswap's useSetupTradeAmountsFromUrl reads.
 *
 * Amount units: the query amount is HUMAN-READABLE whole units (e.g. `100`
 * USDC), NOT atomic/wei. cowswap parses it with tryParseCurrencyAmount(amount,
 * currency), which scales by the resolved token's decimals itself — so the
 * parser's bare amount ("100") is passed straight through, no decimals lookup
 * needed here. (This corrects the earlier V1 note that claimed atomic units and
 * deferred amount pre-fill.)
 *
 * `resolveToken` (optional) rewrites a recognised token SYMBOL to an on-chain
 * ADDRESS for the URL's target chain. Emitting an address (vs the bare symbol)
 * is what makes the swap form fill reliably: an address resolves
 * checksum-insensitively and bypasses the ambiguous-symbol reset
 * (useResetStateWithSymbolDuplication short-circuits on isAddress), so two
 * different tokens sharing a symbol no longer open an empty form. When the
 * resolver returns null (symbol unknown on that chain, or its list isn't
 * loaded) we fall back to the bare symbol, so the URL is always valid.
 */
import type { ParsedIntent } from './types'
import { chainSlugToId } from './chainMap'

// URL amount keys — mirror TRADE_URL_SELL_AMOUNT_KEY / TRADE_URL_BUY_AMOUNT_KEY
// in modules/trade/const/tradeUrl (kept as literals so this stays a
// dependency-free, purely-unit-tested module).
const SELL_AMOUNT_KEY = 'sellAmount'
const BUY_AMOUNT_KEY = 'buyAmount'

export interface IntentFields {
  /** Parsed chain id, or undefined when the intent named no (recognised) chain. */
  chainId?: number
  /** Resolved sell token id (address when resolvable, else bare symbol). */
  sellToken?: string
  /** Resolved buy token id (address when resolvable, else bare symbol). */
  buyToken?: string
  /** Human-readable amount (whole units), or undefined. */
  amount?: string
  /** Side the amount binds to: sell when a sell token exists, else buy. */
  field: 'sell' | 'buy'
}

/**
 * Pull the structured trade fields out of a ParsedIntent, applying the same
 * symbol->address resolution intentToUrl uses. Shared by intentToUrl (the URL)
 * and IntentLanding (the connect-survival stash) so both agree on the exact
 * tokens / chain / amount.
 */
export function extractIntentFields(
  parsed: ParsedIntent,
  resolveToken?: (symbol: string) => string | null,
): IntentFields {
  let chainId: number | undefined
  let sell: string | undefined
  let buy: string | undefined
  let amount: string | undefined

  for (const e of parsed.entities) {
    if (e.type === 'chain' && chainId === undefined) chainId = chainSlugToId(e.value)
    else if (e.type === 'sellToken' && sell === undefined) sell = e.value
    else if (e.type === 'buyToken' && buy === undefined) buy = e.value
    else if (e.type === 'amount' && amount === undefined) amount = e.value
  }

  const resolve = (symbol: string | undefined): string | undefined =>
    symbol === undefined ? undefined : resolveToken?.(symbol) ?? symbol

  return {
    chainId,
    sellToken: resolve(sell),
    buyToken: resolve(buy),
    amount: amount || undefined,
    field: sell !== undefined ? 'sell' : 'buy',
  }
}

export function intentToUrl(parsed: ParsedIntent, resolveToken?: (symbol: string) => string | null): string {
  if (parsed.intent !== 'swap') return '/swap'

  const { chainId, sellToken, buyToken, amount } = extractIntentFields(parsed, resolveToken)

  const segments: string[] = []
  if (chainId !== undefined) segments.push(String(chainId))
  segments.push('swap')

  // Encode token segments: valid symbols/addresses are unaffected, but a
  // malformed parser value (containing `/`, `?`, `#`, …) can't alter the route.
  if (sellToken || buyToken) {
    segments.push(sellToken ? encodeURIComponent(sellToken) : '_')
    if (buyToken) segments.push(encodeURIComponent(buyToken))
  }

  let url = '/' + segments.join('/')

  // Pre-fill the amount (human units) when there is a token for it to bind to:
  // sell side wins when a sell token is present, otherwise a buy-only intent
  // fills the buy amount. cowswap's amount updater ignores an amount whose
  // currency isn't loaded yet and re-applies once it is, so this is always safe.
  if (amount) {
    const amountKey = sellToken ? SELL_AMOUNT_KEY : buyToken ? BUY_AMOUNT_KEY : undefined
    if (amountKey) url += `?${amountKey}=${encodeURIComponent(amount)}`
  }

  return url
}
