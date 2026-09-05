import { decodeFunctionData, encodeFunctionResult, keccak256, type Hex } from 'viem'

import { readFileSync } from 'fs'
import { join } from 'path'

import { OTC_READ_ABI } from './otc.abi'
import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'
import { loadOtcData } from './useOtcData'

import type { OtcManifest, OtcReaderClient } from './otc.types'

const MOCK_CODE: Hex = '0x600160015500'
const BLOCK_HASH: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
// One above the recorded subgraph block so the recorded fixture reads fresh.
const CHAIN_BLOCK = 25_787_579n

function testManifest(overrides: Partial<OtcManifest> = {}): OtcManifest {
  return {
    ...OPHIS_ETHEREUM_OTC_MANIFEST,
    contract: {
      address: OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      runtimeCodeHash: keccak256(MOCK_CODE),
    },
    maxEnumeratedOrders: 144,
    ...overrides,
  }
}

interface SubgraphFixture {
  response: unknown
}

function subgraphFetch(): typeof fetch {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '__fixtures__', 'subgraph-orders.json'), 'utf8'),
  ) as SubgraphFixture
  return jest.fn(async () => ({ ok: true, status: 200, json: async () => fixture.response })) as unknown as typeof fetch
}

function failingFetch(): typeof fetch {
  return jest.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch
}

function createMockClient(blockNumber: bigint = CHAIN_BLOCK): OtcReaderClient {
  return {
    getChainId: async () => 1,
    getLatestBlock: async () => ({ number: blockNumber, hash: BLOCK_HASH, timestamp: 1_755_792_000n }),
    getBlockByNumber: async (blockNumber) => ({ number: blockNumber, hash: BLOCK_HASH, timestamp: 1_755_792_000n }),
    getCode: async () => MOCK_CODE,
    call: async (request) => {
      const { functionName, args } = decodeFunctionData({ abi: OTC_READ_ABI, data: request.data })
      if (functionName === 'weth') {
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'weth',
            result: OPHIS_ETHEREUM_OTC_MANIFEST.wethAddress,
          }),
        }
      }
      if (functionName === 'nextOrderId') {
        return { data: encodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'nextOrderId', result: 144n }) }
      }
      if (functionName === 'getOrders') {
        const ids = (args as readonly [readonly bigint[]])[0]
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'getOrders',
            result: ids.map((orderId) => ({
              maker: '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9',
              active: orderId === 143n,
              tokenA: '0xE9b1cFEA55BAA219e34301f2F31b9FD0921664ED',
              amountA: orderId === 143n ? 100_000_000_000_000_000_000n : 1n,
              tokenB: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
              amountB: orderId === 143n ? 1_000_000_000_000_000_000n : 1n,
            })),
          }),
        }
      }
      throw new Error(`unexpected call: ${String(functionName)}`)
    },
  }
}

describe('loadOtcData', () => {
  it('combines the on-chain snapshot with subgraph enrichment and reconciliation', async () => {
    const result = await loadOtcData(createMockClient(), { manifest: testManifest(), fetchImpl: subgraphFetch() })

    expect(result.snapshot.nextOrderId).toBe(144n)
    expect(result.snapshot.orders).toHaveLength(144)
    expect(result.degradedReason).toBeNull()
    expect(result.enrichment?.indexedBlock).toBe(25_787_578n)
    expect(result.enrichment?.byOrderId.get('143')?.createdAt).toBeGreaterThan(1_700_000_000)
    expect(result.indexLagBlocks).toBe(1n)
    // order 143's indexed terms match the mocked chain state exactly
    expect(result.reconciliation?.verifiedIds).toContainEqual(143n)
    // other indexed orders disagree with the mocked chain values -> mismatches, not verified
    expect(result.reconciliation?.mismatches.length).toBeGreaterThan(0)
  })

  it('degrades (not fails) when the subgraph is unavailable', async () => {
    const result = await loadOtcData(createMockClient(), { manifest: testManifest(), fetchImpl: failingFetch() })

    expect(result.snapshot.orders).toHaveLength(144)
    expect(result.degradedReason).toBe('index-unavailable')
    expect(result.enrichment).toBeNull()
    expect(result.reconciliation).toBeNull()
    expect(result.indexLagBlocks).toBeNull()
  })

  it('degrades as index-corrupt when the subgraph returns malformed rows', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', 'subgraph-orders.json'), 'utf8'),
    ) as SubgraphFixture
    const body = fixture.response as { data: { orders: Record<string, unknown>[] } }
    body.data.orders[0] = { ...body.data.orders[0], maker: 'not-an-address' }
    const corruptFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as unknown as typeof fetch

    const result = await loadOtcData(createMockClient(), { manifest: testManifest(), fetchImpl: corruptFetch })
    expect(result.degradedReason).toBe('index-corrupt')
    expect(result.enrichment).not.toBeNull()
  })

  it('degrades when index lag exceeds the manifest bound', async () => {
    const result = await loadOtcData(createMockClient(), {
      manifest: testManifest({ maxIndexLagBlocks: 0n }),
      fetchImpl: subgraphFetch(),
    })
    expect(result.degradedReason).toBe('index-stale')
    expect(result.enrichment).not.toBeNull()
  })

  it('degrades as node-stale when the index checkpoint is far ahead of this node', async () => {
    // fixture index block is 25_787_578; a node 500 blocks behind it
    const result = await loadOtcData(createMockClient(25_787_078n), {
      manifest: testManifest(),
      fetchImpl: subgraphFetch(),
    })
    expect(result.degradedReason).toBe('node-stale')
  })

  it('lets node-stale outrank index corruption when both are detected', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', 'subgraph-orders.json'), 'utf8'),
    ) as SubgraphFixture
    const body = fixture.response as { data: { orders: Record<string, unknown>[] } }
    body.data.orders[0] = { ...body.data.orders[0], maker: 'not-an-address' }
    const corruptFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as unknown as typeof fetch

    const result = await loadOtcData(createMockClient(25_787_078n), {
      manifest: testManifest(),
      fetchImpl: corruptFetch,
    })
    expect(result.degradedReason).toBe('node-stale')
  })

  it('degrades as index-corrupt on an interior coverage hole', async () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, '__fixtures__', 'subgraph-orders.json'), 'utf8'),
    ) as SubgraphFixture
    const body = fixture.response as { data: { orders: Record<string, unknown>[] } }
    // remove an interior id (between the newest and oldest the index has)
    body.data.orders = body.data.orders.filter((row) => row.orderId !== '130')
    const holeyFetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as unknown as typeof fetch

    const result = await loadOtcData(createMockClient(), { manifest: testManifest(), fetchImpl: holeyFetch })
    expect(result.degradedReason).toBe('index-corrupt')
  })

  it('throws when the on-chain read fails (nothing to show)', async () => {
    const client = createMockClient()
    client.getCode = async () => '0xdead'
    await expect(loadOtcData(client, { manifest: testManifest(), fetchImpl: subgraphFetch() })).rejects.toThrow(
      'Ophis OTC source mismatch',
    )
  })
})
