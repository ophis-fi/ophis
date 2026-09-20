import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { buildSignableOrder, validateFulfillable } from './buildOrder.js'

const request = {
  chainId: 10,
  owner: '0x1111111111111111111111111111111111111111',
  sellToken: '0x4200000000000000000000000000000000000006',
  buyToken: '0x2222222222222222222222222222222222222222',
  sellAmount: '1000',
} as const
const quote = { ...request, sellAmount: '990', feeAmount: '10', buyAmount: '2000', validTo: 4_000_000_000 }
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

test('binds gross input and expiry to the request, preserving the quoted fee split', async () => {
  globalThis.fetch = async () => Response.json({ quote })
  const result = await buildSignableOrder(request, 1_800_000_000)
  assert.equal(result.order.sellAmount, '1000')
  assert.equal(result.order.feeAmount, '0')
  assert.equal(result.order.buyAmount, '1980')
  assert.equal(result.order.validTo, 1_800_001_200)
})

test('refuses quote substitution, over-spend, under-spend, and zero proceeds', async () => {
  for (const patch of [
    { sellToken: request.buyToken }, { buyToken: request.sellToken },
    { sellAmount: '1000000' }, { sellAmount: '1' }, { buyAmount: '1' },
    { feeAmount: '-1' }, { buyAmount: (1n << 256n).toString() },
  ]) {
    globalThis.fetch = async () => Response.json({ quote: { ...quote, ...patch } })
    await assert.rejects(buildSignableOrder(request, 1_800_000_000))
  }
})

test('rejects unfulfillable quantities before accepting a paid job', () => {
  for (const sellAmount of ['0', '-1', '1.5', (1n << 256n).toString()]) {
    assert.notEqual(validateFulfillable({ ...request, sellAmount }), null)
  }
})
