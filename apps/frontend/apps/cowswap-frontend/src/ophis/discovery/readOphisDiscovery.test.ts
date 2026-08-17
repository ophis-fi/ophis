import { encodeFunctionData, encodeFunctionResult, keccak256, type Address, type Hex } from 'viem'

import { OPHIS_DISCOVERY_ABI } from './ophisDiscovery.abi'
import { readOphisDiscovery } from './readOphisDiscovery'

import type { OphisDiscoveryManifest, OphisDiscoveryReaderClient, OphisDiscoveryCall } from './ophisDiscovery.types'

const REGISTRY = '0x1111111111111111111111111111111111111111' as Address
const LENS = '0x2222222222222222222222222222222222222222' as Address
const TOKEN = '0x3333333333333333333333333333333333333333' as Address
const RANKING = '0x4444444444444444444444444444444444444444' as Address
const CODE = '0x60006000' as Hex
const BLOCK_HASH = `0x${'ab'.repeat(32)}` as Hex

const manifest: OphisDiscoveryManifest = {
  chainId: 1,
  chainLabel: 'Ethereum',
  registry: { address: REGISTRY, runtimeCodeHash: keccak256(CODE) },
  lens: { address: LENS, runtimeCodeHash: keccak256(CODE) },
  ranking: { address: RANKING, runtimeCodeHash: keccak256(CODE) },
  pageSize: 12,
  callGasLimit: 2_000_000n,
  maxReturnBytes: 32_768,
}

const sourceResult = encodeFunctionResult({
  abi: OPHIS_DISCOVERY_ABI,
  functionName: 'tokenList',
  result: REGISTRY,
})

const rankingResult = encodeFunctionResult({
  abi: OPHIS_DISCOVERY_ABI,
  functionName: 'conviction',
  result: RANKING,
})

const pageResult = encodeFunctionResult({
  abi: OPHIS_DISCOVERY_ABI,
  functionName: 'summariesPaged',
  result: [
    {
      id: BigInt(TOKEN),
      account: `0x${TOKEN.slice(2).padStart(64, '0')}`,
      chainId: 1n,
      decimals: 18,
      kind: 0,
      standard: 2,
      deployed: true,
      onchainSvg: false,
      synced: true,
      color: 0,
      rank: 1_000,
      frozen: false,
      name: 'Token Three',
      symbol: 'THREE',
    },
  ],
})

interface ClientFixture {
  client: OphisDiscoveryReaderClient
  call: jest.Mock<Promise<{ data?: Hex }>, [OphisDiscoveryCall]>
  getCode: jest.Mock<Promise<Hex | undefined>, [Address, bigint]>
  getBlockByNumber: jest.Mock
}

function makeClient(): ClientFixture {
  const call = jest.fn<Promise<{ data?: Hex }>, [OphisDiscoveryCall]>()
  call
    .mockResolvedValueOnce({ data: sourceResult })
    .mockResolvedValueOnce({ data: rankingResult })
    .mockResolvedValueOnce({ data: pageResult })
  const getCode = jest.fn<Promise<Hex | undefined>, [Address, bigint]>().mockResolvedValue(CODE)
  const getBlockByNumber = jest.fn().mockResolvedValue({ number: 123n, hash: BLOCK_HASH })

  return {
    call,
    getCode,
    getBlockByNumber,
    client: {
      getLatestBlock: jest.fn().mockResolvedValue({ number: 123n, hash: BLOCK_HASH }),
      getBlockByNumber,
      getCode,
      call,
    },
  }
}

describe('readOphisDiscovery', () => {
  it('verifies both runtimes and wiring, reads one block, and retains contract rows', async () => {
    const { client, call, getCode } = makeClient()
    const snapshot = await readOphisDiscovery(client, manifest)

    expect(snapshot).toEqual({
      chainId: 1,
      chainLabel: 'Ethereum',
      blockNumber: 123n,
      blockHash: BLOCK_HASH,
      tokens: [
        {
          id: BigInt(TOKEN).toString(),
          address: TOKEN,
          chainId: 1,
          decimals: 18,
          name: 'Token Three',
          symbol: 'THREE',
          rank: 1_000,
        },
      ],
    })
    expect(call).toHaveBeenCalledTimes(3)
    expect(call.mock.calls[2]?.[0].blockNumber).toBe(123n)
    expect(call.mock.calls[2]?.[0].gas).toBe(manifest.callGasLimit)
    expect(getCode).toHaveBeenCalledWith(TOKEN, 123n)
  })

  it('fails closed when either runtime hash differs', async () => {
    const { client, getCode } = makeClient()
    getCode.mockImplementation(async (address) => (address === LENS ? ('0x6001' as Hex) : CODE))
    await expect(readOphisDiscovery(client, manifest)).rejects.toThrow('source mismatch')
  })

  it('fails closed when the lens points at another registry', async () => {
    const { client, call } = makeClient()
    call.mockReset()
    call.mockResolvedValueOnce({
      data: encodeFunctionResult({
        abi: OPHIS_DISCOVERY_ABI,
        functionName: 'tokenList',
        result: TOKEN,
      }),
    })
    await expect(readOphisDiscovery(client, manifest)).rejects.toThrow('wiring mismatch')
  })

  it('fails closed when the lens points at another ranking contract', async () => {
    const { client, call } = makeClient()
    call.mockReset()
    call.mockResolvedValueOnce({ data: sourceResult }).mockResolvedValueOnce({
      data: encodeFunctionResult({
        abi: OPHIS_DISCOVERY_ABI,
        functionName: 'conviction',
        result: TOKEN,
      }),
    })
    await expect(readOphisDiscovery(client, manifest)).rejects.toThrow('wiring mismatch')
  })

  it('rejects oversized and malformed returndata', async () => {
    const oversized = makeClient()
    oversized.call.mockReset()
    oversized.call.mockResolvedValueOnce({ data: `0x${'00'.repeat(257)}` as Hex })
    await expect(readOphisDiscovery(oversized.client, manifest)).rejects.toThrow('call rejected')

    const malformed = makeClient()
    malformed.call.mockReset()
    malformed.call.mockResolvedValueOnce({ data: '0x01' })
    await expect(readOphisDiscovery(malformed.client, manifest)).rejects.toThrow()
  })

  it('drops a listed address that has no code at the pinned block', async () => {
    const { client, getCode } = makeClient()
    getCode.mockImplementation(async (address) => (address === TOKEN ? '0x' : CODE))
    await expect(readOphisDiscovery(client, manifest)).resolves.toMatchObject({ tokens: [] })
  })

  it('rejects a reorged block instead of mixing snapshots', async () => {
    const { client, getBlockByNumber } = makeClient()
    getBlockByNumber.mockResolvedValue({ number: 123n, hash: `0x${'cd'.repeat(32)}` as Hex })
    await expect(readOphisDiscovery(client, manifest)).rejects.toThrow('block changed')
  })

  it('encodes only the three pinned read selectors', async () => {
    const { client, call } = makeClient()
    await readOphisDiscovery(client, manifest)

    const expectedSelectors = [
      encodeFunctionData({ abi: OPHIS_DISCOVERY_ABI, functionName: 'tokenList' }).slice(0, 10),
      encodeFunctionData({ abi: OPHIS_DISCOVERY_ABI, functionName: 'conviction' }).slice(0, 10),
      encodeFunctionData({
        abi: OPHIS_DISCOVERY_ABI,
        functionName: 'summariesPaged',
        args: [0n, 12n],
      }).slice(0, 10),
    ]
    expect(call.mock.calls.map(([request]) => request.data.slice(0, 10))).toEqual(expectedSelectors)
  })
})
