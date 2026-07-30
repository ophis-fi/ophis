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
  let sellStart: number | undefined
  let buyStart: number | undefined
  let amountStart: number | undefined

  for (const e of parsed.entities) {
    if (e.type === 'chain' && chainId === undefined) chainId = chainSlugToId(e.value)
    else if (e.type === 'sellToken' && sell === undefined) {
      sell = e.value
      sellStart = e.start
    } else if (e.type === 'buyToken' && buy === undefined) {
      buy = e.value
      buyStart = e.start
    } else if (e.type === 'amount' && amount === undefined) {
      amount = e.value
      amountStart = e.start
    }
  }

  const resolve = (symbol: string | undefined): string | undefined =>
    symbol === undefined ? undefined : resolveToken?.(symbol) ?? symbol

  // Bind the amount to the positionally-nearest token, so "buy 500 COW with USDC"
  // (amount adjacent to the BUY token) fills the buy side, while "swap 100 USDC for
  // ETH" (amount adjacent to the SELL token) fills the sell side. Fall back to the
  // sell side when only one token is present or positions are unavailable.
  let field: 'sell' | 'buy'
  if (sell !== undefined && buy !== undefined && amountStart !== undefined) {
    const dSell = sellStart !== undefined ? Math.abs(amountStart - sellStart) : Number.POSITIVE_INFINITY
    const dBuy = buyStart !== undefined ? Math.abs(amountStart - buyStart) : Number.POSITIVE_INFINITY
    field = dBuy < dSell ? 'buy' : 'sell'
  } else {
    field = sell !== undefined ? 'sell' : 'buy'
  }

  return {
    chainId,
    sellToken: resolve(sell),
    buyToken: resolve(buy),
    amount: amount || undefined,
    field,
  }
}

export function intentToUrl(
  parsed: ParsedIntent,
  resolveToken?: (symbol: string) => string | null,
  fallbackChainId?: number,
): string {
  if (parsed.intent !== 'swap') return '/swap'

  const { chainId, sellToken, buyToken, amount, field } = extractIntentFields(parsed, resolveToken)

  // Emit a chain segment whenever we know one (parsed, else the caller's fallback =
  // the connected/default chain). A chainless URL that carries an amount is unsafe:
  // cowswap's SwapPageRedirect rebuilds the path from the DEFAULT pair while keeping
  // the query, so ?sellAmount would apply to WETH/USDC instead of the parsed tokens.
  const effectiveChainId = chainId ?? fallbackChainId

  const segments: string[] = []
  if (effectiveChainId !== undefined) segments.push(String(effectiveChainId))
  segments.push('swap')

  // Encode token segments: valid symbols/addresses are unaffected, but a
  // malformed parser value (containing `/`, `?`, `#`, …) can't alter the route.
  if (sellToken || buyToken) {
    segments.push(sellToken ? encodeURIComponent(sellToken) : '_')
    if (buyToken) segments.push(encodeURIComponent(buyToken))
  }

  let url = '/' + segments.join('/')

  // Pre-fill the amount (human units) on the side it binds to (see extractIntentFields).
  // cowswap's amount updater ignores an amount whose currency isn't loaded yet and
  // re-applies once it is, so this is always safe.
  if (amount) {
    const amountKey = field === 'buy' ? (buyToken ? BUY_AMOUNT_KEY : undefined) : sellToken ? SELL_AMOUNT_KEY : undefined
    if (amountKey) url += `?${amountKey}=${encodeURIComponent(amount)}`
  }

  return url
}
