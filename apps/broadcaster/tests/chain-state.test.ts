import { afterEach, expect, it, vi } from 'vitest'
import type { Block, JsonRpcProvider } from 'ethers'

const now = 1_800_000_000
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

async function fixture(chainId = 1) {
  vi.resetModules()
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
  const { readChainState } = await import('../src/chain-state')
  const block: Partial<Block> = { number: 100, timestamp: now, hash: `0x${'12'.repeat(32)}`, baseFeePerGas: 2n }
  const finalized: Partial<Block> = { number: 80, hash: `0x${'34'.repeat(32)}` }
  const fees = { gasPrice: 5n }
  const provider = {
    getBlock: vi.fn(async (tag: string): Promise<Partial<Block> | null> => tag === 'latest' ? block : finalized),
    getFeeData: vi.fn(async () => fees),
  }
  return { block, finalized, fees, provider,
    run: () => readChainState(provider as unknown as Pick<JsonRpcProvider, 'getBlock' | 'getFeeData'>) }
}

it('retains Ethereum head-minus-one settlement and its base-fee floor without additional RPC calls', async () => {
  const f = await fixture()
  expect(await f.run()).toEqual({ block: f.block, settled: 99, baseFee: 2n, minimumGasPrice: 3n })
  expect(f.provider.getBlock.mock.calls).toEqual([['latest']])
  expect(f.provider.getFeeData).not.toHaveBeenCalled()
})

it.each([42161, 137])('requires finalized settlement and uses only the total chain gas price on chain %i', async (chainId) => {
  const f = await fixture(chainId)
  expect(await f.run()).toEqual({ block: f.block, settled: 80, baseFee: 2n, minimumGasPrice: 3n })
  expect(f.provider.getBlock.mock.calls).toEqual([['latest'], ['finalized']])
  expect(f.provider.getFeeData).not.toHaveBeenCalled()
})

it.each([undefined, null, 0n, 2n])('accepts BNB base fee %s while obtaining its positive minimum gas price from the read node', async (baseFee) => {
  const f = await fixture(56)
  Object.assign(f.block, { baseFeePerGas: baseFee })
  expect(await f.run()).toEqual({ block: f.block, settled: 80, baseFee: baseFee ?? 0n, minimumGasPrice: 5n })
  expect(f.provider.getFeeData).toHaveBeenCalledOnce()
})

it('keeps the BNB minimum gas price above a positive base fee even when the suggested price is lower', async () => {
  const f = await fixture(56)
  Object.assign(f.block, { baseFeePerGas: 9n })
  expect(await f.run()).toEqual({ block: f.block, settled: 80, baseFee: 9n, minimumGasPrice: 10n })
})

it.each([
  { number: -1 }, { number: 1.5 }, { number: Number.MAX_SAFE_INTEGER + 1 },
  { timestamp: now - 46 }, { timestamp: now + 46 }, { timestamp: Number.NaN },
  { hash: null }, { hash: '0x1234' }, { hash: `0x${'00'.repeat(32)}` },
  { baseFeePerGas: null }, { baseFeePerGas: 0n }, { baseFeePerGas: -1n },
])('rejects a stale or malformed Ethereum head %o', async (patch) => {
  const f = await fixture()
  Object.assign(f.block, patch)
  await expect(f.run()).rejects.toThrow()
})

it.each([
  { number: -1 }, { number: 101 }, { number: 80.5 }, { number: 100 },
  { hash: null }, { hash: '0x1234' }, { hash: `0x${'00'.repeat(32)}` },
])('rejects an invalid finalized Arbitrum block %o', async (patch) => {
  const f = await fixture(42161)
  Object.assign(f.finalized, patch)
  await expect(f.run()).rejects.toThrow('finalized')
})

it.each([null, 0n, -1n, '5'])('rejects an unavailable or malformed BNB minimum gas price %s', async (gasPrice) => {
  const f = await fixture(56)
  Object.assign(f.fees, { gasPrice })
  await expect(f.run()).rejects.toThrow('minimum gas price')
})

it('fails closed when the read node cannot provide finalized state', async () => {
  const f = await fixture(137)
  f.provider.getBlock.mockImplementation(async (tag) => tag === 'latest' ? f.block : null)
  await expect(f.run()).rejects.toThrow('finalized')
})
