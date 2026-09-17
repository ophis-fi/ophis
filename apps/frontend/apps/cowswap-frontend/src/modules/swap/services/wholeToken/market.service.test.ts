import { Interface } from '@ethersproject/abi'

import { Market, quoteV3 } from './market.service'
import { MPS, USDC, WETH } from './router.service'

const abi = new Interface(['function quoteExactInput(bytes,uint256) returns (uint256,uint160[],uint32[],uint256)'])
const route = { label: '', tokens: [MPS, USDC, WETH], fees: [10000, 500] }

it.each([
  ['4295128740', '1000000000000'],
  ['1000000000000', '4295128740'],
  ['1461446703485210103287273052203988822378723970341', '1000000000000'],
  ['1000000000000', '1461446703485210103287273052203988822378723970341'],
])('rejects a sell quote when either hop reaches a price limit (%s, %s)', async (...prices) => {
  const market = {
    rpc: { call: jest.fn().mockResolvedValue(abi.encodeFunctionResult('quoteExactInput', [100, prices, [1, 1], 1])) },
  } as unknown as Market
  expect(await quoteV3(market, route, 10n, false, true)).toBe(0n)
  // Existing exact-output buy sizing can still use the available-liquidity estimate.
  expect(await quoteV3(market, route, 10n, false)).toBe(100n)
})

it('keeps a sell quote that consumes its full input before the price boundary', async () => {
  const market = {
    rpc: {
      call: jest
        .fn()
        .mockResolvedValue(abi.encodeFunctionResult('quoteExactInput', [100, [5000000000, 6000000000], [1, 1], 1])),
    },
  } as unknown as Market
  expect(await quoteV3(market, route, 10n, false, true)).toBe(100n)
})
