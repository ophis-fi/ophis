import { beforeEach, expect, it, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

const state = vi.hoisted(() => ({ quote: vi.fn() }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  Contract: class { getFunction() { return { staticCall: state.quote } } },
}))
import { quoteBestRoute, routeCandidates } from './routes'
import { QUOTE, QUOTER } from './config'

const provider = { getBlockNumber: async () => 123 } as unknown as JsonRpcProvider
const missing = () => routeCandidates('USDC', 'WETH').map(() => ({ success: false, returnData: '0x' }))
beforeEach(() => { state.quote.mockReset().mockImplementation(async () => missing()) })

it('compares direct and two-pool quotes at one block and breaks output ties by gas', async () => {
  const routes = routeCandidates('USDC', 'WETH')
  const response = missing()
  response[0] = { success: true, returnData: QUOTE.encodeFunctionResult('quoteExactInput', [500n, [], [], 300n]) }
  response[4] = { success: true, returnData: QUOTE.encodeFunctionResult('quoteExactInput', [500n, [], [], 100n]) }
  state.quote.mockResolvedValue(response)
  const result = await quoteBestRoute(provider, 'USDC', 'WETH', 100n)
  expect(result.route.path).toBe(routes[4].path)
  expect(result.route.tokens).toEqual(['USDC', 'USDT', 'WETH'])
  expect(result.availableRoutes).toBe(2)
  expect(state.quote).toHaveBeenCalledOnce()
  const [calls, options] = state.quote.mock.calls[0]
  expect(options).toEqual({ blockTag: 123, gasLimit: 30_000_000n })
  expect(calls).toHaveLength(20)
  calls.forEach((call: { target: string; allowFailure: boolean; callData: string }, index: number) => {
    expect(call.target).toBe(QUOTER)
    expect(call.allowFailure).toBe(true)
    expect([...QUOTE.decodeFunctionData('quoteExactInput', call.callData)]).toEqual([routes[index].path, 100n])
  })
})

it('does not label an RPC failure as missing liquidity or invent a fallback quote', async () => {
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 100n)).rejects.toThrow(/No supported pool route/)
  state.quote.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }))
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 100n)).rejects.toThrow(/RPC/)
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 0n)).rejects.toThrow(/positive/)
})

it.each([
  { response: [] },
  { response: [{ success: true, returnData: '0x1234' }, ...Array.from({ length: 19 }, () => ({ success: false, returnData: '0x' }))] },
])('rejects incomplete or malformed aggregate results instead of inventing liquidity', async ({ response }) => {
  state.quote.mockResolvedValue(response)
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 100n)).rejects.toThrow(/RPC/)
})
