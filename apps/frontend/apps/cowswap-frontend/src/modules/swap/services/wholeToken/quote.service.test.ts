import { JsonRpcProvider } from '@ethersproject/providers'

import { getMarket, getRoutes, quoteV3 } from './market.service'
import { getDirectQuotes } from './quote.service'
import { MPS, WETH } from './router.service'

jest.mock('./market.service')

const account = '0x1111111111111111111111111111111111111111'
const request = { account, recipient: account, budget: 1000n, slippageBps: 50, fees: [] }
const routes = [500, 3000].map((fee) => ({ label: 'route', tokens: [WETH, MPS], fees: [fee] }))
const rateLimit = new Error('RPC rate limit')

function setup(): JsonRpcProvider {
  const provider = new JsonRpcProvider()
  jest.spyOn(provider, 'getNetwork').mockResolvedValue({ chainId: 1, name: 'homestead' })
  jest.spyOn(provider, 'send').mockResolvedValue('0x64')
  jest.mocked(getRoutes).mockReturnValue(routes)
  jest.mocked(getMarket).mockResolvedValue({
    rpc: { check: () => {}, call: jest.fn() },
    blockNumber: 42,
    timestamp: Math.floor(Date.now() / 1000),
    baseFee: 0n,
    priorityFee: 0n,
    approvalGas: 0n,
    inputPerEth: 10n ** 18n,
    usdcReserve: 1000n,
    mpsReserve: 100n,
  })
  jest
    .mocked(quoteV3)
    .mockImplementation(async (_market, _route, amount, exactOutput) => (exactOutput ? amount * 10n : 3n))
  return provider
}

test('compares complete routes and does not inflate spend to the budget', async () => {
  const quotes = await getDirectQuotes(setup(), request)
  expect(quotes).toHaveLength(2)
  expect(quotes.map((quote) => [quote.buyAmount, quote.sellAmount])).toEqual([
    [3n, 30n],
    [3n, 30n],
  ])
})

test.each(['route', 'search', 'simulation', 'reserves'])(
  'fails incomplete %s comparisons instead of returning a worse quote',
  async (stage) => {
    const provider = setup()
    if (stage === 'reserves') jest.mocked(getMarket).mockRejectedValue(rateLimit)
    else if (stage === 'simulation')
      jest.mocked(provider.send).mockResolvedValueOnce('0x64').mockRejectedValue(rateLimit)
    else
      jest.mocked(quoteV3).mockImplementation(async (_market, route, amount, exactOutput) => {
        if ((stage === 'route' && route.fees[0] === 3000) || (stage === 'search' && exactOutput && amount === 2n))
          throw rateLimit
        return exactOutput ? amount * 10n : 3n
      })
    await expect(getDirectQuotes(provider, request)).rejects.toBe(rateLimit)
  },
)
