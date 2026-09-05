import { decodeFunctionData, encodeFunctionResult, keccak256, type Address, type Hex } from 'viem'

import { OTC_READ_ABI } from './otc.abi'
import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'
import { readOtcSnapshot } from './readOtcSnapshot'

import type { OtcManifest, OtcOrder, OtcReadCall, OtcReaderClient } from './otc.types'

const MOCK_CODE: Hex = '0x600160015500'
const BLOCK_HASH: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
const MAKER: Address = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const TOKEN_A: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const TOKEN_B: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

function testManifest(overrides: Partial<OtcManifest> = {}): OtcManifest {
  return {
    ...OPHIS_ETHEREUM_OTC_MANIFEST,
    contract: {
      address: OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      runtimeCodeHash: keccak256(MOCK_CODE),
    },
    orderBatchSize: 2,
    maxEnumeratedOrders: 4,
    ...overrides,
  }
}

function orderTupleFor(orderId: bigint): {
  maker: Address
  active: boolean
  tokenA: Address
  amountA: bigint
  tokenB: Address
  amountB: bigint
} {
  return {
    maker: MAKER,
    active: orderId % 2n === 0n,
    tokenA: TOKEN_A,
    amountA: orderId + 1n,
    tokenB: TOKEN_B,
    amountB: (orderId + 1n) * 2n,
  }
}

interface MockClientOptions {
  nextOrderId: bigint
  chainId?: number
  wethAddress?: Address
  code?: Hex
  reReadHash?: Hex
}

interface MockClient extends OtcReaderClient {
  calls: OtcReadCall[]
}

function createMockClient(options: MockClientOptions): MockClient {
  const wethAddress = options.wethAddress ?? OPHIS_ETHEREUM_OTC_MANIFEST.wethAddress
  const calls: OtcReadCall[] = []

  return {
    calls,
    getChainId: async () => options.chainId ?? 1,
    getLatestBlock: async () => ({ number: 100n, hash: BLOCK_HASH, timestamp: 1_755_792_000n }),
    getBlockByNumber: async (blockNumber) => ({
      number: blockNumber,
      hash: options.reReadHash ?? BLOCK_HASH,
      timestamp: 1_755_792_000n,
    }),
    getCode: async () => options.code ?? MOCK_CODE,
    call: async (request) => {
      calls.push(request)
      const { functionName, args } = decodeFunctionData({ abi: OTC_READ_ABI, data: request.data })
      if (functionName === 'weth') {
        return { data: encodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'weth', result: wethAddress }) }
      }
      if (functionName === 'nextOrderId') {
        return {
          data: encodeFunctionResult({ abi: OTC_READ_ABI, functionName: 'nextOrderId', result: options.nextOrderId }),
        }
      }
      if (functionName === 'getOrders') {
        const ids = (args as readonly [readonly bigint[]])[0]
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'getOrders',
            result: ids.map(orderTupleFor),
          }),
        }
      }
      throw new Error(`unexpected call: ${functionName}`)
    },
  }
}

describe('readOtcSnapshot', () => {
  it('reads a consistent snapshot, enumerating ids newest-first from 0', async () => {
    const client = createMockClient({ nextOrderId: 3n })
    const snapshot = await readOtcSnapshot(client, testManifest())

    expect(snapshot.blockNumber).toBe(100n)
    expect(snapshot.blockHash).toBe(BLOCK_HASH)
    expect(snapshot.nextOrderId).toBe(3n)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.orders.map((order: OtcOrder) => order.orderId)).toEqual([2n, 1n, 0n])
    expect(snapshot.orders[0]).toEqual({ orderId: 2n, ...orderTupleFor(2n) })

    // every eth_call is pinned to the snapshot block
    expect(client.calls.length).toBeGreaterThan(0)
    for (const call of client.calls) {
      expect(call.blockNumber).toBe(100n)
    }
  })

  it('bounds enumeration to maxEnumeratedOrders and flags truncation', async () => {
    const client = createMockClient({ nextOrderId: 10n })
    const snapshot = await readOtcSnapshot(client, testManifest())

    expect(snapshot.truncated).toBe(true)
    expect(snapshot.orders.map((order: OtcOrder) => order.orderId)).toEqual([9n, 8n, 7n, 6n])
  })

  it('splits enumeration into bounded getOrders batches', async () => {
    const client = createMockClient({ nextOrderId: 3n })
    await readOtcSnapshot(client, testManifest())

    const batchSizes = client.calls
      .map((call) => decodeFunctionData({ abi: OTC_READ_ABI, data: call.data }))
      .filter((decoded) => decoded.functionName === 'getOrders')
      .map((decoded) => (decoded.args as readonly [readonly bigint[]])[0].length)
    expect(batchSizes).toEqual([2, 1])
  })

  it('fails closed when the RPC serves a different chain', async () => {
    const client = createMockClient({ nextOrderId: 3n, chainId: 10 })
    await expect(readOtcSnapshot(client, testManifest())).rejects.toThrow('Ophis OTC wrong chain')
  })

  it('fails closed on a runtime code hash mismatch', async () => {
    const client = createMockClient({ nextOrderId: 3n, code: '0xdead' })
    await expect(readOtcSnapshot(client, testManifest())).rejects.toThrow('Ophis OTC source mismatch')
  })

  it('fails closed when weth() wiring disagrees with the manifest', async () => {
    const client = createMockClient({ nextOrderId: 3n, wethAddress: TOKEN_B })
    await expect(readOtcSnapshot(client, testManifest())).rejects.toThrow('Ophis OTC wiring mismatch')
  })

  it('fails closed when the block hash changes under the read', async () => {
    const client = createMockClient({
      nextOrderId: 3n,
      reReadHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    })
    await expect(readOtcSnapshot(client, testManifest())).rejects.toThrow('Ophis OTC block changed')
  })

  it('rejects returndata larger than the manifest bound', async () => {
    const client = createMockClient({ nextOrderId: 3n })
    await expect(readOtcSnapshot(client, testManifest({ maxReturnBytes: 32 }))).rejects.toThrow(
      'Ophis OTC call rejected',
    )
  })

  it('rejects a latest block without a hash', async () => {
    const client = createMockClient({ nextOrderId: 3n })
    client.getLatestBlock = async () => ({ number: 100n, hash: null })
    await expect(readOtcSnapshot(client, testManifest())).rejects.toThrow('Ophis OTC block is not identifiable')
  })

  it('returns an empty snapshot when no orders exist yet', async () => {
    const client = createMockClient({ nextOrderId: 0n })
    const snapshot = await readOtcSnapshot(client, testManifest())
    expect(snapshot.orders).toEqual([])
    expect(snapshot.truncated).toBe(false)
  })
})
