import { afterEach, expect, it, vi } from 'vitest'
import { getAddress, Interface, type JsonRpcProvider } from 'ethers'

const now = 1_800_000_000
const abi = new Interface(['function decimals() view returns (uint8)', 'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'])
const addresses: Record<number, string[]> = {
  1: [1, 2, 3].map((value) => `0x${value.toString(16).padStart(40, '0')}`),
  42161: ['0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
    '0x3f3f5dF88dC9F13eac63DF89EC16ef6e7E25DdE7', '0xFdB631F5EE196F0ed6FAa767959853A9F217697D'],
  56: ['0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE', '0x51597f405303C4377E36123cBc172b13269EA163',
    '0xB97Ad0E74fa7d920791E90258A6E2085088b4320'],
  137: ['0xAB594600376Ec9fD91F8e885dADF0CE036862dE0', '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
    '0x0A6513e40db6EB1b165753AD52E80663aeA50545'],
}

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

async function fixture(chainId: number) {
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
  const { FeeOracle } = await import('../src/fees')
  const { TOKENS } = await import('../src/config')
  const nativePrice = chainId === 56 ? 700_00000000n : chainId === 137 ? 10_000_000n : 2500_00000000n
  const feeds = [chainId === 56 ? 'BNB / USD' : chainId === 137 ? 'MATIC / USD' : 'ETH / USD', 'USDC / USD', 'USDT / USD']
    .map((description, index) => ({ description, decimals: 8, code: '0x6001',
      round: [5n, index === 0 ? nativePrice : 100_000_000n, BigInt(now - 1), BigInt(now - 1), 5n] }))
  if (chainId === 42161) feeds.push({ description: 'L2 Sequencer Uptime Status Feed', decimals: 0, code: '0x6001',
    round: [5n, 0n, BigInt(now - 1_000_000), BigInt(now - 1_000_000), 5n] })
  const indexOf = (address: string) => {
    const index = addresses[chainId].findIndex((candidate) => getAddress(candidate) === getAddress(address))
    if (index < 0) throw new Error('Unexpected oracle address.')
    return index
  }
  const provider = {
    resolveName: vi.fn(async (name: string) => {
      const index = ['eth-usd.data.eth', 'usdc-usd.data.eth', 'usdt-usd.data.eth'].indexOf(name)
      if (chainId !== 1 || index < 0) throw new Error('Unexpected ENS resolution.')
      return addresses[1][index]
    }),
    getCode: vi.fn(async (address: string) => feeds[indexOf(address)].code),
    getBlock: vi.fn(async () => ({ number: 100, timestamp: now })),
    call: vi.fn(async ({ to, data }: { to: string; data: string; blockTag?: number }) => {
      const feed = feeds[indexOf(to)], method = abi.parseTransaction({ data })!.name
      return abi.encodeFunctionResult(method, method === 'decimals' ? [feed.decimals]
        : method === 'description' ? [feed.description] : feed.round)
    }),
  }
  return { oracle: new FeeOracle(provider as unknown as JsonRpcProvider, 1500n), feeds, provider, TOKENS }
}

it.each([
  [1, 2_875_000_000n], [42161, 2_875_000_000n], [56, 805_000_000_000_000_000_000n], [137, 115_000n],
])('prices the selected native currency and stablecoin precision on chain %i', async (chainId, stableRate) => {
  const { oracle, provider, TOKENS } = await fixture(chainId)
  expect(await oracle.rates()).toEqual({ [getAddress(TOKENS[0].address)]: 1_150_000_000_000_000_000n,
    [getAddress(TOKENS[1].address)]: stableRate, [getAddress(TOKENS[2].address)]: stableRate })
  expect(provider.resolveName).toHaveBeenCalledTimes(chainId === 1 ? 3 : 0)
  expect(provider.getCode.mock.calls.map(([address]) => address)).toEqual(addresses[chainId])
  for (const [call] of provider.call.mock.calls)
    if (abi.parseTransaction({ data: call.data })!.name === 'latestRoundData') expect(call.blockTag).toBe(100)
})

it('rounds BNB stablecoin reimbursement upward with non-integral prices and a markup', async () => {
  const { oracle, feeds, TOKENS } = await fixture(56)
  feeds[0].round[1] = 70_000_000_001n
  feeds[1].round[1] = 99_000_001n
  const rate = (await oracle.rates())[getAddress(TOKENS[1].address)]
  const required = feeds[0].round[1] * 10n ** 18n * 11_500n
  expect(rate * feeds[1].round[1] * 10_000n).toBeGreaterThanOrEqual(required)
  expect((rate - 2n) * feeds[1].round[1] * 10_000n).toBeLessThan(required)
})

it.each([[1, 0, 3720], [56, 0, 87], [56, 1, 960], [137, 1, 87]])(
  'does not let chain %i cache extend feed %i freshness past %is', async (chainId, feed, age) => {
    const f = await fixture(chainId)
    f.feeds[feed].round[3] = BigInt(now - age)
    await expect(f.oracle.rates()).resolves.toBeDefined()
    const reads = f.provider.call.mock.calls.length
    vi.spyOn(Date, 'now').mockReturnValue((now + 1) * 1000)
    f.provider.getBlock.mockResolvedValue({ number: 101, timestamp: now + 1 })
    await expect(f.oracle.rates()).rejects.toThrow('stale or invalid')
    expect(f.provider.call.mock.calls.length).toBeGreaterThan(reads)
  },
)

it('bounds cached freshness relative to a permitted future head as well as wall time', async () => {
  const f = await fixture(137)
  f.provider.getBlock.mockResolvedValue({ number: 100, timestamp: now + 1 })
  f.feeds[1].round[3] = BigInt(now + 1 - 87)
  await expect(f.oracle.rates()).resolves.toBeDefined()
  vi.spyOn(Date, 'now').mockReturnValue((now + 1) * 1000)
  f.provider.getBlock.mockResolvedValue({ number: 101, timestamp: now + 2 })
  await expect(f.oracle.rates()).rejects.toThrow('stale or invalid')
})

it('rejects a refresh whose source freshness expires during asynchronous reads', async () => {
  const f = await fixture(137)
  f.feeds[1].round[3] = BigInt(now - 87)
  const read = f.provider.call.getMockImplementation()!
  f.provider.call.mockImplementation(async (request) => {
    const value = await read(request)
    if (abi.parseTransaction({ data: request.data })!.name === 'latestRoundData')
      vi.spyOn(Date, 'now').mockReturnValue((now + 1) * 1000)
    return value
  })
  await expect(f.oracle.rates()).rejects.toThrow('expired during refresh')
})

it.each([
  ['missing code', 'unavailable'], ['wrong precision', 'identity or precision'], ['wrong native identity', 'identity or precision'],
  ['stale price', 'stale or invalid'], ['future price', 'stale or invalid'], ['zero price', 'stale or invalid'],
  ['unfinished round', 'stale or invalid'], ['depegged low', 'outside the accepted band'],
  ['depegged high', 'outside the accepted band'], ['stale node', 'read node is stale'],
])('fails closed for %s', async (condition, error) => {
  const { oracle, feeds, provider } = await fixture(137)
  if (condition === 'missing code') feeds[1].code = '0x'
  if (condition === 'wrong precision') feeds[1].decimals = 18
  if (condition === 'wrong native identity') feeds[0].description = 'POL / USD'
  if (condition === 'stale price') feeds[0].round[3] = BigInt(now - 88)
  if (condition === 'future price') feeds[0].round[3] = BigInt(now + 1)
  if (condition === 'zero price') feeds[0].round[1] = 0n
  if (condition === 'unfinished round') feeds[0].round[4] = 4n
  if (condition === 'depegged low') feeds[1].round[1] = 97_999_999n
  if (condition === 'depegged high') feeds[1].round[1] = 102_000_001n
  if (condition === 'stale node') provider.getBlock.mockResolvedValue({ number: 100, timestamp: now - 46 })
  await expect(oracle.rates()).rejects.toThrow(error)
})

it.each([[56, 0, 87], [56, 1, 960], [137, 1, 87], [42161, 0, 1815], [42161, 1, 315]])(
  'bounds chain %i feed %i freshness by its published heartbeat plus tolerance', async (chainId, index, age) => {
    const { oracle, feeds } = await fixture(chainId)
    feeds[index].round[3] = BigInt(now - age - 1)
    await expect(oracle.rates()).rejects.toThrow('stale or invalid')
    feeds[index].round[3] = BigInt(now - age)
    await expect(oracle.rates()).resolves.toBeDefined()
  },
)

it.each(['down', 'uninitialized', 'future', 'inconsistent', 'unfinished', 'just recovered', 'grace boundary'])(
  'rejects Arbitrum prices while the sequencer is %s', async (condition) => {
    const { oracle, feeds } = await fixture(42161)
    const round = feeds[3].round
    if (condition === 'down') round[1] = 1n
    if (condition === 'uninitialized') round[2] = 0n
    if (condition === 'future') round[2] = round[3] = BigInt(now + 1)
    if (condition === 'inconsistent') round[3] = round[2] - 1n
    if (condition === 'unfinished') round[4] = 4n
    if (condition === 'just recovered') round[2] = round[3] = BigInt(now - 3599)
    if (condition === 'grace boundary') round[2] = round[3] = BigInt(now - 3600)
    await expect(oracle.rates()).rejects.toThrow('sequencer is unavailable')
  },
)

it('rechecks Arbitrum sequencer status even while the price cache is young', async () => {
  const { oracle, feeds } = await fixture(42161)
  await expect(oracle.rates()).resolves.toBeDefined()
  feeds[3].round[1] = 1n
  await expect(oracle.rates()).rejects.toThrow('sequencer is unavailable')
})

it('resumes Arbitrum pricing immediately after the full recovery grace period', async () => {
  const { oracle, feeds } = await fixture(42161)
  feeds[3].round[2] = feeds[3].round[3] = BigInt(now - 3601)
  await expect(oracle.rates()).resolves.toBeDefined()
})

it('requires the pinned Arbitrum sequencer feed identity', async () => {
  const { oracle, feeds } = await fixture(42161)
  feeds[3].description = 'ETH / USD'
  await expect(oracle.rates()).rejects.toThrow('identity or precision')
})
