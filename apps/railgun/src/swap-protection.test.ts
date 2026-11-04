import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type JsonRpcProvider } from 'ethers'

const state = vi.hoisted(() => ({ quote: vi.fn(), best: vi.fn() }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  Contract: class {
    getFunction(name: string) {
      return name === 'quoteExactInput' ? { staticCall: state.quote } : async () => 25n
    }
  },
}))
vi.mock('./routes', async (original) => ({ ...await original<typeof import('./routes')>(), quoteBestRoute: state.best }))
import { assertFinalQuoteFresh, quoteSwap, recipeCalls, revalidateSwapQuote, type SwapQuote } from './recipe'
import { OPHIS_FEE, PRIVATE_SLIPPAGE_BPS } from './config'
import { routeCandidates } from './routes'

const account = '0x0000000000000000000000000000000000001234'
const block = { number: 123, timestamp: Math.floor(Date.now() / 1000) }
const provider = {
  getNetwork: async () => ({ chainId: 1n }), getBlock: vi.fn().mockResolvedValue(block),
} as unknown as JsonRpcProvider
let quote: SwapQuote

beforeEach(async () => {
  vi.clearAllMocks()
  vi.mocked(provider.getBlock).mockResolvedValue(block as Awaited<ReturnType<JsonRpcProvider['getBlock']>>)
  state.best.mockResolvedValue({ route: routeCandidates('USDC', 'WETH')[0], amountOut: 1_000_000n, availableRoutes: 1 })
  state.quote.mockResolvedValue([1_000_000n])
  quote = await quoteSwap(provider, 'USDC', '1', account, 'WETH')
})
afterEach(() => vi.restoreAllMocks())

it('commits half the 0.1% price tolerance after the Ophis fee, reserving the rest for movement during proving', async () => {
  for (const gross of [1n, 999n, 1_000_001n, 2n ** 100n]) {
    state.best.mockResolvedValue({ route: quote.route, amountOut: gross })
    const current = await quoteSwap(provider, 'USDC', '1', account, 'WETH')
    const net = gross - gross * OPHIS_FEE.bps / 10_000n
    expect(current.minimum).toBeGreaterThan(0n)
    expect((net - current.minimum) * 10_000n).toBeLessThanOrEqual(net * PRIVATE_SLIPPAGE_BPS)
    expect(current.minimum).toBe(net - net * (PRIVATE_SLIPPAGE_BPS / 2n) / 10_000n)
    expect(current.deadline).toBe(block.timestamp + 600)
  }
})

it('rechecks only the proved path with one bounded call and leaves the proved calls unchanged', async () => {
  const calls = structuredClone(quote.calls)
  expect(await revalidateSwapQuote(provider, quote)).toMatchObject({ monotonic: expect.any(Number), wallTime: expect.any(Number) })
  expect(state.quote).toHaveBeenCalledExactlyOnceWith(quote.route?.path, quote.swapAmount, {
    blockTag: block.number, gasLimit: 5_000_000n,
  })
  expect(state.best).toHaveBeenCalledOnce()
  expect(quote.calls).toEqual(calls)
  state.quote.mockResolvedValueOnce([999_500n])
  await expect(revalidateSwapQuote(provider, quote)).resolves.toHaveProperty('monotonic')
  state.quote.mockResolvedValueOnce([1_000_001n])
  await expect(revalidateSwapQuote(provider, quote)).resolves.toHaveProperty('monotonic')
})

it.each([990_000n, 1_001_000n])('blocks adverse movement and an old floor exposing improved output (%s)', async (gross) => {
  state.quote.mockResolvedValueOnce([gross])
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/Price moved/)
})

it('rejects a previously wider price floor even if the route still executes', async () => {
  quote.minimum = quote.expected * 9950n / 10_000n
  quote.calls = recipeCalls(quote.sell, quote.buy, quote.account, quote.swapAmount, quote.minimum, quote.deadline, quote.route?.path)
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/Price moved/)
})

it('rejects mismatched proof-bound calls before making another RPC call', async () => {
  quote.calls[2].data = '0x1234'
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/differ/)
  expect(state.quote).not.toHaveBeenCalled()
})

it('rejects expired chain time, unavailable quotes and slow final price calls', async () => {
  vi.mocked(provider.getBlock).mockResolvedValueOnce({ ...block, timestamp: quote.deadline - 60 } as Awaited<ReturnType<JsonRpcProvider['getBlock']>>)
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/expired/)
  expect(state.quote).not.toHaveBeenCalled()
  state.quote.mockRejectedValueOnce(new Error('RPC offline'))
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/RPC offline/)
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000)
  state.quote.mockImplementationOnce(async () => { clock.mockReturnValue(31_000); return [1_000_000n] })
  await expect(revalidateSwapQuote(provider, quote)).rejects.toThrow(/Final price check expired/)
})

it('requires a recent monotonic clock reading instead of a missing, future or expired check', () => {
  vi.spyOn(performance, 'now').mockReturnValue(31_000)
  expect(() => assertFinalQuoteFresh({ monotonic: 1001, wallTime: Date.now() })).not.toThrow()
  expect(() => assertFinalQuoteFresh(undefined)).toThrow(/Final price check expired/)
  for (const monotonic of [NaN, Infinity, 31_001, 1000, -Infinity])
    expect(() => assertFinalQuoteFresh({ monotonic, wallTime: Date.now() })).toThrow(/Final price check expired/)
})

it('rejects suspended browsers and backwards wall-clock changes even if the monotonic clock barely moved', () => {
  vi.spyOn(performance, 'now').mockReturnValue(1000)
  vi.spyOn(Date, 'now').mockReturnValue(100_000)
  expect(() => assertFinalQuoteFresh({ monotonic: 999, wallTime: 70_000 })).toThrow(/Final price check expired/)
  expect(() => assertFinalQuoteFresh({ monotonic: 999, wallTime: 100_001 })).toThrow(/Final price check expired/)
})
