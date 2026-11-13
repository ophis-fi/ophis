import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { arrayify } from '@ethersproject/bytes'
import { _TypedDataEncoder } from '@ethersproject/hash'
import { verifyMessage } from '@ethersproject/wallet'

import {
  RELAY_CHAINS,
  RELAY_DEPOSIT_WINDOW,
  RELAY_SOLVER,
  relayCurrency,
  relayRouterData,
  relayRefundCurrencies,
} from './relay.constants'
import { RelayResponse } from './relay.types'
import { RELAY_ORDER_TYPES } from './relayOrder.constants'

export function relayAssert(condition: unknown): asserts condition {
  if (!condition) throw new Error('Relay returned unsupported or mismatched bridge terms')
}
export function relayAmount(value: unknown): bigint {
  relayAssert(typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value))
  const amount = BigInt(value)
  relayAssert(amount < 2n ** 256n)
  return amount
}

// EVM addresses are already Relay's canonical bytes encoding. Fail closed on any schema/signature change.
export function verifyRelayQuote(value: unknown, request: QuoteBridgeRequest, now: number): RelayResponse {
  const quote = value as RelayResponse
  const protocol = quote.protocol.v2
  const order = protocol.orderData
  relayAssert(/^0x[\da-f]{64}$/i.test(quote.requestId) && protocol.hubType === 'onchain')
  relayAssert(order.version === 'v1' && areAddressesEqual(order.solver, RELAY_SOLVER))
  relayAssert(_TypedDataEncoder.hashStruct('Order', RELAY_ORDER_TYPES, order) === protocol.orderId)
  relayAssert(areAddressesEqual(verifyMessage(arrayify(protocol.orderId), protocol.orderSignature), RELAY_SOLVER))
  relayAssert(order.inputs.length === 1 && order.output.payments.length === 1)
  relayAssert(order.output.calls.length === 0)
  relayAssert(order.fees.length === 0)
  relayAssert(['0x', relayRouterData(request.buyTokenChainId)].includes(order.output.extraData))
  relayAssert(Number.isSafeInteger(order.output.deadline) && order.output.deadline > now + RELAY_DEPOSIT_WINDOW)
  const input = order.inputs[0]
  const output = order.output.payments[0]
  relayAssert(input.payment.chainId === RELAY_CHAINS[request.sellTokenChainId])
  relayAssert(areAddressesEqual(input.payment.currency, request.sellTokenAddress))
  relayAssert(
    relayAmount(input.payment.amount) === request.amount && request.amount > 0n && input.payment.weight === '1',
  )
  relayAssert(order.output.chainId === RELAY_CHAINS[request.buyTokenChainId])
  relayAssert(areAddressesEqual(output.recipient, request.receiver || request.account))
  relayAssert(areAddressesEqual(output.currency, relayCurrency(request.buyTokenAddress)))
  relayAssert(input.refunds.length > 0)
  input.refunds.forEach((refund) => {
    relayAssert(areAddressesEqual(refund.recipient, request.account))
    relayAssert(
      [
        '0x',
        relayRouterData(refund.chainId === input.payment.chainId ? request.sellTokenChainId : request.buyTokenChainId),
      ].includes(refund.extraData),
    )
    relayAssert([input.payment.chainId, order.output.chainId].includes(refund.chainId))
    const source = refund.chainId === input.payment.chainId
    relayAssert(
      relayRefundCurrencies(
        source ? request.sellTokenChainId : request.buyTokenChainId,
        source ? request.sellTokenAddress : request.buyTokenAddress,
      ).some((currency) => areAddressesEqual(currency, refund.currency)),
    )
  })
  const minimum = relayAmount(output.minimumAmount)
  const expected = relayAmount(output.expectedAmount)
  relayAssert(minimum > 0n && expected >= minimum)
  relayAssert(minimum === relayAmount(quote.details.currencyOut.minimumAmount))
  relayAssert(expected === relayAmount(quote.details.currencyOut.amount))
  return quote
}
