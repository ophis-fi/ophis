import { readFileSync } from 'fs'
import { join } from 'path'

import { computeIndexLag, fetchOtcIndexedOrders } from './otcSubgraph'

interface SubgraphFixture {
  response: { data: Record<string, unknown> }
}

function fixtureBody(): { data: Record<string, unknown> } {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'subgraph-orders.json'), 'utf8'),
  ) as SubgraphFixture
  return fixture.response
}

function mockFetch(body: unknown, status = 200): typeof fetch {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

describe('fetchOtcIndexedOrders', () => {
  it('parses the recorded subgraph page', async () => {
    const result = await fetchOtcIndexedOrders(mockFetch(fixtureBody()))

    expect(result.indexedBlock).toBe(25_787_578n)
    expect(result.droppedRows).toBe(0)
    expect(result.orders).toHaveLength(25)

    const order143 = result.orders.find((order) => order.orderId === 143n)
    expect(order143).toMatchObject({
      orderId: 143n,
      maker: '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9',
      active: true,
      tokenA: '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED',
      amountA: 100_000_000_000_000_000_000n,
      tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountB: 1_000_000_000_000_000_000n,
      taker: null,
      filledAt: null,
      cancelledAt: null,
    })
    expect(order143?.createdAt).toBeGreaterThan(1_700_000_000)
    expect(order143?.createdTx).toMatch(/^0x[0-9a-f]{64}$/)

    const order139 = result.orders.find((order) => order.orderId === 139n)
    expect(order139?.active).toBe(false)
    expect(order139?.filledAt).toBeGreaterThan(1_700_000_000)
    expect(order139?.filledTx).toMatch(/^0x[0-9a-f]{64}$/)
    expect(order139?.taker).toMatch(/^0x[0-9a-fA-F]{40}$/)

    const order141 = result.orders.find((order) => order.orderId === 141n)
    expect(order141?.cancelledAt).toBeGreaterThan(1_700_000_000)
  })

  it('drops malformed rows and reports the count', async () => {
    const body = fixtureBody()
    const orders = body.data.orders as Record<string, unknown>[]
    orders[0] = { ...orders[0], maker: 'not-an-address' }

    const result = await fetchOtcIndexedOrders(mockFetch(body))
    expect(result.droppedRows).toBe(1)
    expect(result.orders).toHaveLength(24)
  })

  it('rejects a response without index-block metadata', async () => {
    const body = fixtureBody()
    delete body.data._meta
    await expect(fetchOtcIndexedOrders(mockFetch(body))).rejects.toThrow('Ophis OTC index response rejected')
  })

  it('rejects a non-ok HTTP response', async () => {
    await expect(fetchOtcIndexedOrders(mockFetch({}, 502))).rejects.toThrow('Ophis OTC index request failed')
  })

  it('rejects a GraphQL error payload', async () => {
    await expect(fetchOtcIndexedOrders(mockFetch({ errors: [{ message: 'boom' }] }))).rejects.toThrow(
      'Ophis OTC index request failed',
    )
  })
})

describe('computeIndexLag', () => {
  it('returns the block distance, floored at zero', () => {
    expect(computeIndexLag(100n, 160n)).toBe(60n)
    expect(computeIndexLag(160n, 100n)).toBe(0n)
    expect(computeIndexLag(100n, 100n)).toBe(0n)
  })
})
