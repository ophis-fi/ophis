import { BridgeQuoteResults } from '@cowprotocol/sdk-bridging'

import {
  ACROSS_DAPP_ID,
  ACROSS_QUOTE_TIME_BUFFER,
  FILL_MARGIN,
  NEAR_DAPP_ID,
  NEAR_DEPOSIT_MARGIN,
  QUOTE_TIME_MARGIN,
} from './ophisAcrossConstants'

/**
 * The latest validTo an order may carry with this bridge quote. The placed hook
 * may run until validTo, when the Across deposit must still accept the quote time
 * (with QUOTE_TIME_MARGIN to spare) and leave relayers FILL_MARGIN. Infinity for
 * any other provider's quote.
 */
export function acrossValidToLimit(bridgeQuote: BridgeQuoteResults | null): number {
  if (bridgeQuote?.providerInfo.dappId !== ACROSS_DAPP_ID) return Infinity

  return Math.min(
    bridgeQuote.quoteTimestamp + Number(ACROSS_QUOTE_TIME_BUFFER - QUOTE_TIME_MARGIN),
    quotedFillDeadline(bridgeQuote.quoteBody) - Number(FILL_MARGIN),
  )
}

/**
 * The latest validTo an order may carry with a NEAR Intents quote. The order pays
 * NEAR's deposit address when it fills, and NEAR refunds a deposit made after the
 * quote's deadline (fixed when quoting, 30 min on) instead of bridging it, while
 * the order would otherwise run for the whole swap deadline (up to 12 h). The
 * deadline is the one NEAR attested (the quoteBody is the attested quote). 0, so
 * no order, when it cannot be read; Infinity for any other provider's quote.
 */
export function nearValidToLimit(bridgeQuote: BridgeQuoteResults | null): number {
  if (bridgeQuote?.providerInfo.dappId !== NEAR_DAPP_ID) return Infinity

  try {
    const deadline = Date.parse(JSON.parse(bridgeQuote.quoteBody ?? '').deadline) / 1000
    return Number.isFinite(deadline) ? Math.floor(deadline) - NEAR_DEPOSIT_MARGIN : 0
  } catch {
    return 0
  }
}

// An Across quoteBody is its stringified suggested-fees response.
function quotedFillDeadline(quoteBody: string | undefined): number {
  try {
    return Number(JSON.parse(quoteBody ?? '{}').fillDeadline ?? Infinity)
  } catch {
    return Infinity
  }
}
