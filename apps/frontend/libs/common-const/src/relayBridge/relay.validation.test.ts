import { OrderKind, SupportedChainId } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import sample from './fixtures/usdc-base-optimism.json'
import { verifyRelayQuote } from './relay.validation'

const request: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  amount: BigInt(sample.request.amount),
  account: sample.request.user,
  sellTokenChainId: SupportedChainId.BASE,
  sellTokenAddress: sample.request.originCurrency,
  sellTokenDecimals: 6,
  buyTokenChainId: 10 as SupportedChainId,
  buyTokenAddress: sample.request.destinationCurrency,
  buyTokenDecimals: 6,
}
const now = Date.parse('2026-11-13T12:00:00Z') / 1000

it('verifies a live 3 bps bridge quote against the official order hash and pinned solver', () => {
  expect(verifyRelayQuote(sample.response, request, now).protocol.v2.orderId).toBe(sample.response.protocol.v2.orderId)
})

it.each([
  ['source chain', { sellTokenChainId: SupportedChainId.MAINNET }],
  ['destination chain', { buyTokenChainId: SupportedChainId.ARBITRUM_ONE }],
  ['source token', { sellTokenAddress: sample.request.destinationCurrency }],
  ['destination token', { buyTokenAddress: sample.request.originCurrency }],
  ['input amount', { amount: request.amount + 1n }],
  ['recipient', { receiver: '0x4242424242424242424242424242424242424242' }],
  ['refund wallet', { account: '0x4242424242424242424242424242424242424242' }],
])('rejects a valid solver signature for a different %s', (_, overrides) => {
  expect(() => verifyRelayQuote(sample.response, { ...request, ...overrides }, now)).toThrow()
})

it.each([
  'recipient',
  'minimum',
  'input',
  'refund',
  'calls',
  'signature',
  'orderId',
  'reportedMinimum',
  'expiry',
  'router',
])('rejects tampered %s', (field) => {
  const quote = JSON.parse(JSON.stringify(sample.response)) as typeof sample.response
  const protocol = quote.protocol.v2
  const mutations: Record<string, () => void> = {
    recipient: () => {
      protocol.orderData.output.payments[0].recipient = sample.request.originCurrency
    },
    minimum: () => {
      protocol.orderData.output.payments[0].minimumAmount = '1'
    },
    input: () => {
      protocol.orderData.inputs[0].payment.amount = '1'
    },
    refund: () => {
      protocol.orderData.inputs[0].refunds[0].recipient = sample.request.originCurrency
    },
    calls: () => {
      ;(protocol.orderData.output.calls as string[]).push('0x1234')
    },
    signature: () => {
      protocol.orderSignature = `0x${'00'.repeat(65)}`
    },
    orderId: () => {
      protocol.orderId = `0x${'42'.repeat(32)}`
    },
    reportedMinimum: () => {
      quote.details.currencyOut.minimumAmount = '1'
    },
    expiry: () => {
      protocol.orderData.output.deadline = 0
    },
    router: () => {
      protocol.orderData.output.extraData = '0x1234'
    },
  }
  mutations[field]()
  expect(() => verifyRelayQuote(quote, request, now)).toThrow()
})

it.each([null, {}, [], { protocol: { v2: {} } }])('fails closed on malformed response %#', (value) => {
  expect(() => verifyRelayQuote(value, request, now)).toThrow()
})

it('refuses expired signed orders', () => {
  expect(() =>
    verifyRelayQuote(sample.response, request, sample.response.protocol.v2.orderData.output.deadline),
  ).toThrow()
})
