import { OrderKind, PriceQuality, QuoteAndPost, SwapAdvancedSettings } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { bridgingSdk } from 'tradingSdk/bridgingSdk'

export async function getSwapQuote(params: QuoteBridgeRequest, settings: SwapAdvancedSettings): Promise<QuoteAndPost> {
  const original = (await bridgingSdk.getQuote(params, settings)) as QuoteAndPost
  if (!isWholeTokenSell(params) || settings.quoteRequest?.priceQuality === PriceQuality.FAST) {
    return original
  }

  const recovered = await recoverWholeToken(params, settings, original)
  return minimizeWholeTokenInput(params, settings, recovered)
}

async function minimizeWholeTokenInput(
  params: QuoteBridgeRequest,
  settings: SwapAdvancedSettings,
  original: QuoteAndPost,
): Promise<QuoteAndPost> {
  const output = original.quoteResults.amountsAndCosts.afterPartnerFees.buyAmount
  if (output <= 0n) return original
  try {
    // BUY is only a price hint. Keep a real SELL quote and its SDK signing callback.
    const hint = (await bridgingSdk.getQuote(
      { ...params, kind: OrderKind.BUY, amount: output },
      settings,
    )) as QuoteAndPost
    const input = hint.quoteResults.quoteResponse.quote.sellAmount
    const quoteRequest = { ...settings.quoteRequest, sellAmountBeforeFee: undefined, sellAmountAfterFee: input }
    const candidate = (await bridgingSdk.getQuote(params, {
      ...settings,
      quoteRequest,
    })) as QuoteAndPost
    return candidate.quoteResults.amountsAndCosts.amountsToSign.sellAmount <= params.amount &&
      isBetterQuote(candidate, original)
      ? candidate
      : original
  } catch {
    return original
  }
}

async function recoverWholeToken(
  params: QuoteBridgeRequest,
  settings: SwapAdvancedSettings,
  original: QuoteAndPost,
): Promise<QuoteAndPost> {
  // The orderbook scales an already-rounded buy amount down for network fees:
  // 1 MPS * (budget - fee) / budget becomes 0. Quote the actual input instead.
  let fee = BigInt(original.quoteResults.quoteResponse.quote.feeAmount)
  // ponytail: bound fee convergence to three quotes; keep the original if gas keeps rising.
  for (let attempt = 0; attempt < 3 && fee < params.amount; attempt++) {
    try {
      const quoteRequest = {
        ...settings.quoteRequest,
        sellAmountBeforeFee: undefined,
        sellAmountAfterFee: (params.amount - fee).toString(),
      }
      const candidate = (await bridgingSdk.getQuote(params, {
        ...settings,
        quoteRequest,
      })) as QuoteAndPost
      const amounts = candidate.quoteResults.amountsAndCosts
      if (amounts.amountsToSign.sellAmount <= params.amount) {
        return isBetterQuote(candidate, original) ? candidate : original
      }
      const updatedFee = BigInt(candidate.quoteResults.quoteResponse.quote.feeAmount)
      // Reserve 1% on retries so tiny gas-estimate changes do not prevent convergence.
      // This is input left unspent, not an added fee.
      fee = updatedFee + (updatedFee + 99n) / 100n
    } catch {
      // An optional improvement must not discard an existing quote on RPC/API failure.
      return original
    }
  }
  return original
}

function isWholeTokenSell(params: QuoteBridgeRequest): boolean {
  return (
    params.kind === OrderKind.SELL &&
    params.buyTokenDecimals === 0 &&
    params.sellTokenChainId === params.buyTokenChainId
  )
}

function isBetterQuote(candidate: QuoteAndPost, original: QuoteAndPost): boolean {
  const next = candidate.quoteResults.amountsAndCosts
  const previous = original.quoteResults.amountsAndCosts
  if (next.amountsToSign.buyAmount < previous.amountsToSign.buyAmount) return false
  const received = next.afterPartnerFees.buyAmount
  const previousReceived = previous.afterPartnerFees.buyAmount
  return (
    received > previousReceived ||
    (received === previousReceived && next.amountsToSign.sellAmount < previous.amountsToSign.sellAmount)
  )
}
