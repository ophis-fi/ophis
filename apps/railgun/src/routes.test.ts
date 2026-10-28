import { beforeEach, expect, it, vi } from 'vitest'
import type { JsonRpcProvider } from 'ethers'

const state = vi.hoisted(() => ({ quote: vi.fn() }))
vi.mock('ethers', async (original) => ({
  ...await original<typeof import('ethers')>(),
  Contract: class { getFunction() { return { staticCall: state.quote } } },
}))
import { quoteBestRoute, routeCandidates } from './routes'

const provider = { getBlockNumber: async () => 123 } as unknown as JsonRpcProvider
const missing = () => { throw Object.assign(new Error('No pool'), { code: 'CALL_EXCEPTION' }) }
beforeEach(() => { state.quote.mockReset().mockImplementation(missing) })

it('compares direct and two-pool quotes at one block and breaks output ties by gas', async () => {
  const routes = routeCandidates('USDC', 'WETH')
  state.quote.mockImplementation(async (path) => {
    if (path === routes[0].path) return [500n, [], [], 300n]
    if (path === routes[4].path) return [500n, [], [], 100n]
    return missing()
  })
  const result = await quoteBestRoute(provider, 'USDC', 'WETH', 100n)
  expect(result.route.path).toBe(routes[4].path)
  expect(result.route.tokens).toEqual(['USDC', 'USDT', 'WETH'])
  expect(result.availableRoutes).toBe(2)
  expect(state.quote.mock.calls.every((call) => call[1] === 100n && call[2].blockTag === 123)).toBe(true)
})

it('does not label an RPC failure as missing liquidity or invent a fallback quote', async () => {
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 100n)).rejects.toThrow(/No supported pool route/)
  state.quote.mockRejectedValueOnce(Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }))
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 100n)).rejects.toThrow(/RPC/)
  await expect(quoteBestRoute(provider, 'USDC', 'WETH', 0n)).rejects.toThrow(/positive/)
})
