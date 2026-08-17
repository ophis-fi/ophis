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
import { chainSlugToId } from './chainMap'

import type { ParsedIntent } from './types'

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

interface CollectedIntentFields {
  chainId?: number
  sell?: string
  buy?: string
  amount?: string
  sellStart?: number
  buyStart?: number
  amountStart?: number
}

function collectIntentEntity(fields: CollectedIntentFields, entity: ParsedIntent['entities'][number]): void {
  if (entity.type === 'chain' && fields.chainId === undefined) {
    fields.chainId = chainSlugToId(entity.value)
    return
  }
  if (entity.type === 'sellToken' && fields.sell === undefined) {
    fields.sell = entity.value
    fields.sellStart = entity.start
    return
  }
  if (entity.type === 'buyToken' && fields.buy === undefined) {
    fields.buy = entity.value
    fields.buyStart = entity.start
    return
  }
  if (entity.type === 'amount' && fields.amount === undefined) {
    fields.amount = entity.value
    fields.amountStart = entity.start
  }
}

function resolveIntentToken(
  symbol: string | undefined,
  resolveToken?: (symbol: string) => string | null,
): string | undefined {
  if (symbol === undefined) return undefined
  return resolveToken?.(symbol) ?? symbol
}

function getIntentAmountField(fields: CollectedIntentFields): 'sell' | 'buy' {
  const { sell, buy, amountStart, sellStart, buyStart } = fields
  if (sell === undefined || buy === undefined || amountStart === undefined) return sell !== undefined ? 'sell' : 'buy'

  const sellDistance = sellStart === undefined ? Number.POSITIVE_INFINITY : Math.abs(amountStart - sellStart)
  const buyDistance = buyStart === undefined ? Number.POSITIVE_INFINITY : Math.abs(amountStart - buyStart)
  return buyDistance < sellDistance ? 'buy' : 'sell'
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
  const fields: CollectedIntentFields = {}
  parsed.entities.forEach((entity) => collectIntentEntity(fields, entity))

  // Bind the amount to the positionally-nearest token, so "buy 500 COW with USDC"
  // (amount adjacent to the BUY token) fills the buy side, while "swap 100 USDC for
  // ETH" (amount adjacent to the SELL token) fills the sell side. Fall back to the
  // sell side when only one token is present or positions are unavailable.
  return {
    chainId: fields.chainId,
    sellToken: resolveIntentToken(fields.sell, resolveToken),
    buyToken: resolveIntentToken(fields.buy, resolveToken),
    amount: fields.amount || undefined,
    field: getIntentAmountField(fields),
  }
}

function buildIntentPath(chainId: number | undefined, sellToken: string | undefined, buyToken: string | undefined): string {
  const segments = chainId === undefined ? ['swap'] : [String(chainId), 'swap']
  if (sellToken || buyToken) {
    segments.push(sellToken ? encodeURIComponent(sellToken) : '_')
    if (buyToken) segments.push(encodeURIComponent(buyToken))
  }
  return `/${segments.join('/')}`
}

function buildAmountQuery(fields: IntentFields): string {
  if (!fields.amount) return ''
  const amountKey = fields.field === 'buy' ? (fields.buyToken ? BUY_AMOUNT_KEY : null) : fields.sellToken ? SELL_AMOUNT_KEY : null
  return amountKey ? `?${amountKey}=${encodeURIComponent(fields.amount)}` : ''
}

export function intentToUrl(
  parsed: ParsedIntent,
  resolveToken?: (symbol: string) => string | null,
  fallbackChainId?: number,
): string {
  if (parsed.intent !== 'swap') return '/swap'

  const fields = extractIntentFields(parsed, resolveToken)

  // Emit a chain segment whenever we know one (parsed, else the caller's fallback =
  // the connected/default chain). A chainless URL that carries an amount is unsafe:
  // cowswap's SwapPageRedirect rebuilds the path from the DEFAULT pair while keeping
  // the query, so ?sellAmount would apply to WETH/USDC instead of the parsed tokens.
  const effectiveChainId = fields.chainId ?? fallbackChainId
  return buildIntentPath(effectiveChainId, fields.sellToken, fields.buyToken) + buildAmountQuery(fields)
}
