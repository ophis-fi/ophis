import { decodeFunctionData, encodeFunctionResult, keccak256, type Address, type Hex } from 'viem'

import { OTC_READ_ABI } from './otc.abi'
import { OPHIS_ETHEREUM_OTC_MANIFEST } from './otc.const'
import { readOtcOrder } from './readOtcSnapshot'

import type { OtcManifest, OtcReaderClient } from './otc.types'

const MOCK_CODE: Hex = '0x600160015500'
const BLOCK_HASH: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111'
const MAKER = '0x9a50A078d80F36E38EDfAE85AfFa2B8aB458e2C9'
const ZERO = '0x0000000000000000000000000000000000000000'

function testManifest(): OtcManifest {
  return {
    ...OPHIS_ETHEREUM_OTC_MANIFEST,
    contract: {
      address: OPHIS_ETHEREUM_OTC_MANIFEST.contract.address,
      runtimeCodeHash: keccak256(MOCK_CODE),
    },
  }
}

interface MockOptions {
  existing?: boolean
  chainId?: number
  wethAddress?: Address
  code?: Hex
  reReadHash?: Hex
}

function createMockClient(options: MockOptions = {}): OtcReaderClient {
  const existing = options.existing ?? true
  return {
    getChainId: async () => options.chainId ?? 1,
    getLatestBlock: async () => ({ number: 200n, hash: BLOCK_HASH, timestamp: 1_755_792_000n }),
    getBlockByNumber: async (blockNumber) => ({
      number: blockNumber,
      hash: options.reReadHash ?? BLOCK_HASH,
      timestamp: 1_755_792_000n,
    }),
    getCode: async () => options.code ?? MOCK_CODE,
    call: async (request) => {
      const { functionName } = decodeFunctionData({ abi: OTC_READ_ABI, data: request.data })
      if (functionName === 'weth') {
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'weth',
            result: options.wethAddress ?? OPHIS_ETHEREUM_OTC_MANIFEST.wethAddress,
          }),
        }
      }
      if (functionName === 'getOrder') {
        return {
          data: encodeFunctionResult({
            abi: OTC_READ_ABI,
            functionName: 'getOrder',
            result: {
              maker: existing ? MAKER : ZERO,
              active: existing,
              tokenA: existing ? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' : ZERO,
              amountA: existing ? 5n : 0n,
              tokenB: existing ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : ZERO,
              amountB: existing ? 10n : 0n,
            },
          }),
        }
      }
      throw new Error(`unexpected call: ${String(functionName)}`)
    },
  }
}

describe('readOtcOrder', () => {
  it('rejects a stalled RPC within the manifest deadline', async () => {
    jest.useFakeTimers()
    try {
      const client = createMockClient()
      client.getCode = () => new Promise<never>(() => undefined)
      const manifest = testManifest()
      const rejection = expect(readOtcOrder(client, 42n, manifest)).rejects.toThrow('Ophis OTC order read timed out')
      await jest.advanceTimersByTimeAsync(manifest.readTimeoutMs)
      await rejection
    } finally {
      jest.useRealTimers()
    }
  })

  it('reads a single order directly with code verification', async () => {
    const result = await readOtcOrder(createMockClient(), 42n, testManifest())
    expect(result.blockNumber).toBe(200n)
    expect(result.blockHash).toBe(BLOCK_HASH)
    expect(result.order).toEqual({
      orderId: 42n,
      maker: MAKER,
      active: true,
      tokenA: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      amountA: 5n,
      tokenB: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      amountB: 10n,
    })
  })

  it('returns a null order for a non-existent id', async () => {
    const result = await readOtcOrder(createMockClient({ existing: false }), 42n, testManifest())
    expect(result.order).toBeNull()
    expect(result.blockNumber).toBe(200n)
    expect(result.blockHash).toBe(BLOCK_HASH)
  })

  it('fails closed when the RPC serves a different chain', async () => {
    await expect(readOtcOrder(createMockClient({ chainId: 10 }), 42n, testManifest())).rejects.toThrow(
      'Ophis OTC wrong chain',
    )
  })

  it('fails closed on a code hash mismatch', async () => {
    await expect(readOtcOrder(createMockClient({ code: '0xdead' }), 42n, testManifest())).rejects.toThrow(
      'Ophis OTC source mismatch',
    )
  })

  it('fails closed when weth() wiring disagrees with the manifest', async () => {
    const client = createMockClient({ wethAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' })
    await expect(readOtcOrder(client, 42n, testManifest())).rejects.toThrow('Ophis OTC wiring mismatch')
  })

  it('fails closed when the block hash changes under the read', async () => {
    const client = createMockClient({
      reReadHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    })
    await expect(readOtcOrder(client, 42n, testManifest())).rejects.toThrow('Ophis OTC block changed')
  })
})
