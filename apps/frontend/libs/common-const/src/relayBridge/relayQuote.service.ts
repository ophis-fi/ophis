import { areAddressesEqual, OrderKind } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { RELAY_DEPOSIT_WINDOW, relayCurrency } from './relay.constants'
import { RelayQuote } from './relay.types'
import { verifyRelayQuote } from './relay.validation'
import { RelayApi } from './relayApi.service'

export async function relayQuote(api: RelayApi, request: QuoteBridgeRequest, shed: string): Promise<RelayQuote> {
  if (request.kind !== OrderKind.SELL) throw new Error('Relay supports sell orders only')
  const slippageBps = request.bridgeSlippageBps ?? 10
  const response = await api.request('quote', {
    user: shed,
    recipient: request.receiver || request.account,
    refundTo: request.account,
    originChainId: request.sellTokenChainId,
    destinationChainId: request.buyTokenChainId,
    originCurrency: request.sellTokenAddress,
    destinationCurrency: relayCurrency(request.buyTokenAddress),
    amount: request.amount.toString(),
    slippageBps,
  })
  const quoteTimestamp = Math.floor(Date.now() / 1000)
  const relay = verifyRelayQuote(response, request, quoteTimestamp)
  const buyAmount = BigInt(relay.details.currencyOut.amount)
  const minimum = BigInt(relay.details.currencyOut.minimumAmount)
  const grossBuy = (request.amount * 10n ** BigInt(request.buyTokenDecimals)) / 10n ** BigInt(request.sellTokenDecimals)
  const feeBuy = grossBuy > buyAmount ? grossBuy - buyAmount : 0n
  const feeSell = (feeBuy * 10n ** BigInt(request.sellTokenDecimals)) / 10n ** BigInt(request.buyTokenDecimals)
  const depositUntil = quoteTimestamp + RELAY_DEPOSIT_WINDOW
  return {
    relay,
    request,
    depositUntil,
    id: relay.requestId,
    quoteTimestamp,
    isSell: true,
    quoteBody: JSON.stringify({
      relay,
      request: { ...request, amount: String(request.amount), signer: undefined },
      depositUntil,
    }),
    amountsAndCosts: {
      beforeFee: { sellAmount: request.amount, buyAmount: grossBuy },
      afterFee: { sellAmount: request.amount, buyAmount },
      afterSlippage: { sellAmount: request.amount, buyAmount: minimum },
      slippageBps,
      costs: {
        bridgingFee: {
          feeBps: Number((feeSell * 10_000n) / request.amount),
          amountInSellCurrency: feeSell,
          amountInBuyCurrency: feeBuy,
        },
      },
    },
    expectedFillTimeSeconds: Number.isFinite(relay.details.timeEstimate) ? relay.details.timeEstimate : undefined,
    fees: { bridgeFee: feeSell, destinationGasFee: 0n },
    limits: { minDeposit: request.amount, maxDeposit: request.amount },
  }
}

export function sameRelayRequest(a: QuoteBridgeRequest, b: QuoteBridgeRequest): boolean {
  return (
    a.sellTokenChainId === b.sellTokenChainId &&
    a.buyTokenChainId === b.buyTokenChainId &&
    a.amount === b.amount &&
    areAddressesEqual(a.account, b.account) &&
    areAddressesEqual(a.receiver || a.account, b.receiver || b.account) &&
    areAddressesEqual(a.sellTokenAddress, b.sellTokenAddress) &&
    areAddressesEqual(a.buyTokenAddress, b.buyTokenAddress)
  )
}
