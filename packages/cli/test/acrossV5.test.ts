import { expect, test } from 'bun:test'
import {
  ACROSS_V5_ADAPTER, acrossStoreData, acrossV5FixedAmount, checkAcrossV5Deposit,
  parseAcrossV5Quote, parseAcrossV5Status,
} from '../../../functions/_shared/acrossV5.ts'
import { acrossV5BridgeQuote, readAcrossV5Order } from '../../../functions/_shared/acrossV5Client.ts'

const originChainId = 8453
const destinationChainId = 5042
const inputToken = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
const outputToken = '0x3600000000000000000000000000000000000000'
const depositor = '0x1111111111111111111111111111111111111111'
const recipient = '0x2222222222222222222222222222222222222222'
const orderId = '0x' + 'ab'.repeat(32)
const amount = '99900000'
const request = { originChainId, destinationChainId, inputToken, outputToken, depositor, recipient, amount }
const response = () => ({
  amountType: 'exact_input',
  orderId,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  originValidUntil: new Date(Date.now() + 900_000).toISOString(),
  origin: { token: { chainId: originChainId, address: inputToken }, amount, maxAmount: amount, depositor: { address: depositor } },
  destination: {
    token: { chainId: destinationChainId, address: outputToken },
    amount: '99700000', minAmount: '99300000', grossAmount: amount,
    recipient: { address: recipient },
  },
  fee: { appFee: { amount: '0' } },
  refundTo: [{ token: { chainId: originChainId, address: inputToken }, refundAddress: { address: depositor } }],
  nextActions: [
    { id: 'approval', kind: 'approve_token', ecosystem: 'evm', chainId: originChainId, tokenAddress: inputToken, spender: ACROSS_V5_ADAPTER, amount },
    { id: 'prefunded-store', kind: 'send_transaction', ecosystem: 'evm', chainId: originChainId, to: ACROSS_V5_ADAPTER, value: '0', data: acrossStoreData(orderId, inputToken, amount) },
  ],
})

test('prices the fixed debit and keeps the V5 floor and order ID', () => {
  expect(acrossV5FixedAmount(100_000_000n)).toBe(BigInt(amount))
  const quote = parseAcrossV5Quote(response(), request, 0)
  expect(() => checkAcrossV5Deposit(quote, request)).not.toThrow()
  const result = acrossV5BridgeQuote(quote, 100_000_000n, recipient)
  expect(result.amountsAndCosts.afterFee.buyAmount).toBe(99_700_000n)
  expect(result.amountsAndCosts.afterSlippage.buyAmount).toBe(99_300_000n)
  expect(readAcrossV5Order(result.quoteBody)).toMatchObject({ orderId, amount, recipient })
})

test('refuses a substituted witness, redirect, permissive approval, expiry, or undisclosed app fee', () => {
  const updates: ((q: ReturnType<typeof response>) => void)[] = [
    (q) => { q.nextActions[1].data = acrossStoreData('0x' + 'ee'.repeat(32), inputToken, amount) },
    (q) => { q.destination.recipient.address = depositor },
    (q) => { q.refundTo[0].refundAddress.address = recipient },
    (q) => { q.nextActions[0].amount = '999999' },
    (q) => { q.expiresAt = new Date(0).toISOString() },
    (q) => { q.fee.appFee.amount = '30000' },
    (q) => { q.nextActions[1].to = recipient },
  ]
  for (const update of updates) {
    const q = response()
    update(q)
    expect(() => parseAcrossV5Quote(q, request, 0)).toThrow()
  }
  const paid = response()
  paid.fee.appFee.amount = '30000'
  expect(parseAcrossV5Quote(paid, request, 3).appFee).toBe('30000')
})

test('only a matching terminal transfer is mapped to completion or refund', () => {
  const txnRef = '0x' + 'cd'.repeat(32)
  const tx = { type: 'refund', transaction: { txnRef } }
  const refunded = { orderId, status: { state: 'refunded', isTerminal: true }, transactions: [tx] }
  expect(parseAcrossV5Status(refunded, orderId)).toMatchObject({ status: 'refund', fillTxHash: txnRef })
  expect(parseAcrossV5Status(refunded, txnRef).status).toBe('unknown')
  expect(parseAcrossV5Status({ ...refunded, status: { state: 'pending', isTerminal: false } }, orderId).status)
    .toBe('in_progress')
})
