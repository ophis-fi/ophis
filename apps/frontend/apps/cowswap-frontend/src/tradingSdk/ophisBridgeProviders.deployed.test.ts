import { USDG_ROBINHOOD, WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { readFileSync } from 'fs'
import { join } from 'path'

import { ACROSS_EXECUTABLE_SOURCE_IDS, OphisAcrossBridgeProvider } from './ophisBridgeProviders'

// The deployed build: cloudflare-deploy.yml sets REACT_APP_ACROSS_ROBINHOOD_SOURCE,
// REACT_APP_ACROSS_OPTIMISM_SOURCE and REACT_APP_ACROSS_POLYGON_SOURCE to 'true'.
jest.mock('@cowprotocol/common-const', () => {
  const actual = jest.requireActual<typeof import('@cowprotocol/common-const')>('@cowprotocol/common-const')

  return {
    ...actual,
    EXTRA_ACROSS_SOURCE_CHAIN_IDS: [
      ...actual.acrossRobinhoodSourceIds(true),
      ...actual.acrossPolygonOptimismSourceIds(true, true),
    ],
  }
})

// The shipped Ophis list is the trusted list the corridors below run on.
const SHIPPED: TokenInfo[] = JSON.parse(
  readFileSync(join(__dirname, '../../public/token-lists/ophis.json'), 'utf8'),
).tokens

function listed(chainId: number, symbol: string): TokenInfo {
  const token = SHIPPED.find((entry) => entry.chainId === chainId && entry.symbol === symbol)
  if (!token) throw new Error(`${symbol} on ${chainId} is not on the Ophis list`)
  return token
}

class ShippedListProvider extends OphisAcrossBridgeProvider {
  protected trustedTokens(): Promise<TokenInfo[]> {
    return Promise.resolve(SHIPPED)
  }
}

const request = (sell: TokenInfo, buy: TokenInfo): QuoteBridgeRequest =>
  ({
    kind: OrderKind.SELL,
    sellTokenChainId: sell.chainId,
    sellTokenAddress: sell.address,
    sellTokenDecimals: sell.decimals,
    buyTokenChainId: buy.chainId,
    buyTokenAddress: buy.address,
    buyTokenDecimals: buy.decimals,
    amount: 10_000_000n,
  }) as unknown as QuoteBridgeRequest

// Across's symbol match hands over `candidate`: the addresses that survive.
async function intermediates(candidate: TokenInfo, destination: TokenInfo): Promise<string[]> {
  jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([candidate])
  const kept = await new ShippedListProvider().getIntermediateTokens(request(candidate, destination))
  return kept.map(({ address }) => address)
}

const USDG_4663 = listed(4663, 'USDG')

afterEach(() => jest.restoreAllMocks())

it('runs with the deployed Across sources and the Robinhood USDG the corridor names', () => {
  expect([...ACROSS_EXECUTABLE_SOURCE_IDS].sort((a, b) => a - b)).toEqual([1, 10, 137, 4663, 8453, 42161])
  expect(USDG_4663).toMatchObject({ address: USDG_ROBINHOOD.address, decimals: 6 })
})

it.each([1, 10, 137, 8453, 42161])('keeps chain %i USDC -> Robinhood USDG', async (chainId) => {
  const usdc = listed(chainId, 'USDC')

  expect(await intermediates(usdc, USDG_4663)).toEqual([usdc.address])
})

it.each([1, 130, 8453, 42161])('keeps Robinhood USDG -> chain %i USDC', async (chainId) => {
  expect(await intermediates(USDG_4663, listed(chainId, 'USDC'))).toEqual([USDG_4663.address])
})

// Corridors the 2026-10-16 list additions open: each side is an Ophis list entry
// or a pinned wrapped gas token.
const BASE_WETH = WRAPPED_NATIVE_CURRENCIES[SupportedChainId.BASE]
it.each([
  ['Arbitrum USD₮0 -> Polygon USDT0', listed(42161, 'USD₮0'), listed(137, 'USDT0')],
  ['Ethereum USDT -> Arbitrum USD₮0', listed(1, 'USDT'), listed(42161, 'USD₮0')],
  ['Arbitrum WBTC -> Ethereum WBTC', listed(42161, 'WBTC'), listed(1, 'WBTC')],
  ['Ethereum WBTC -> Polygon WBTC', listed(1, 'WBTC'), listed(137, 'WBTC')],
  ['Polygon WBTC -> Linea WBTC', listed(137, 'WBTC'), listed(59144, 'WBTC')],
  ['Ethereum USDG -> Robinhood USDG', listed(1, 'USDG'), USDG_4663],
  ['Polygon WETH -> Base WETH', listed(137, 'WETH'), BASE_WETH],
  ['Base WETH -> BNB Chain ETH', BASE_WETH, listed(56, 'ETH')],
])('keeps %s', async (_, source, destination) => {
  expect(await intermediates(source, destination)).toEqual([source.address])
})

it('still refuses USDC into another USDG, USDG into another asset, other decimals and unlisted tokens', async () => {
  const usdc = listed(1, 'USDC')

  expect(await intermediates(usdc, listed(130, 'USDG'))).toEqual([])
  expect(await intermediates(usdc, listed(57073, 'USDG'))).toEqual([])
  expect(await intermediates(USDG_4663, listed(130, 'USDT'))).toEqual([])
  // BNB Chain's USDC has 18 decimals.
  expect(await intermediates(USDG_4663, listed(56, 'USDC'))).toEqual([])
  expect(await intermediates({ ...usdc, address: `0x${'cc'.repeat(20)}` }, USDG_4663)).toEqual([])
})

it('quotes Robinhood USDG -> Unichain USDC, which no other provider serves', async () => {
  // The suggested-fees response shape (illustrative values); the 4663 SpokePool
  // is the one the sdk-bridging patch registers.
  const fees = {
    estimatedFillTimeSec: 2,
    timestamp: '1790090000',
    isAmountTooLow: false,
    quoteBlock: '123',
    spokePoolAddress: '0xD29C85F15DF544bA632C9E25829fd29d767d7978',
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    exclusivityDeadline: 0,
    fillDeadline: '1790097440',
    totalRelayFee: { pct: '1000000000000000', total: '10000' },
    relayerCapitalFee: { pct: '0', total: '0' },
    relayerGasFee: { pct: '0', total: '0' },
    lpFee: { pct: '0', total: '0' },
    limits: {
      minDeposit: '1000000',
      maxDeposit: '1000000000000',
      maxDepositInstant: '1000000000000',
      maxDepositShortDelay: '1000000000000',
      recommendedDepositInstant: '1000000000000',
    },
  }
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => fees } as Response)

  const quote = await new ShippedListProvider().getQuote(request(USDG_4663, listed(130, 'USDC')))

  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.searchParams.get('originChainId')).toBe('4663')
  expect(url.searchParams.get('destinationChainId')).toBe('130')
  expect(quote.amountsAndCosts.afterFee.buyAmount).toBe(9_990_000n)
})
