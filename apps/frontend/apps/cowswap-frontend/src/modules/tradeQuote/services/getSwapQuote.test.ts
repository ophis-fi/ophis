import { getQuoteAmountsAndCosts, OrderKind, PriceQuality, QuoteAndPost, SigningScheme } from '@cowprotocol/cow-sdk'
import { QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { bridgingSdk } from 'tradingSdk/bridgingSdk'

import { getSwapQuote } from './getSwapQuote'

jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: { getQuote: jest.fn() } }))

const request = {
  kind: OrderKind.SELL,
  amount: 3300n,
  sellTokenChainId: 1,
  buyTokenChainId: 1,
  sellTokenDecimals: 18,
  buyTokenDecimals: 0,
} as QuoteBridgeRequest
const settings = { quoteRequest: { priceQuality: PriceQuality.OPTIMAL } }
const mockQuote = jest.mocked(bridgingSdk.getQuote)

function quote(sellAmount: string, buyAmount: string, feeAmount: string): QuoteAndPost {
  const orderParams = { kind: OrderKind.SELL, sellAmount, buyAmount, feeAmount }
  const amountsAndCosts = getQuoteAmountsAndCosts({
    orderParams,
    partnerFeeBps: 51,
    protocolFeeBps: 2,
    slippagePercentBps: 1877,
  })
  return {
    quoteResults: {
      quoteResponse: { quote: { ...orderParams, signingScheme: SigningScheme.EIP1271 }, id: 42 },
      amountsAndCosts,
      orderToSign: {
        sellAmount: amountsAndCosts.amountsToSign.sellAmount.toString(),
        buyAmount: amountsAndCosts.amountsToSign.buyAmount.toString(),
      },
    },
    postSwapOrderFromQuote: jest.fn(),
  } as unknown as QuoteAndPost
}

beforeEach(() => mockQuote.mockReset())

it('recovers 1 whole token within the budget and preserves the SDK signing payload and callback', async () => {
  const original = quote('2600', '0', '700')
  const recovered = quote('2600', '1', '650')
  mockQuote.mockResolvedValueOnce(original).mockResolvedValueOnce(recovered)

  const result = await getSwapQuote(request, settings)

  expect(result).toBe(recovered)
  expect(result.quoteResults.orderToSign).toEqual({ sellAmount: '3250', buyAmount: '1' })
  // 18.77% cannot remove a fraction of a whole MPS; the signed minimum stays 1.
  expect(result.quoteResults.amountsAndCosts.afterSlippage.buyAmount).toBe(1n)
  expect(mockQuote).toHaveBeenLastCalledWith(request, {
    quoteRequest: { priceQuality: PriceQuality.OPTIMAL, sellAmountBeforeFee: undefined, sellAmountAfterFee: '2600' },
  })
})

it('recovers a lost unit for a nonzero quote too', async () => {
  const original = quote('3000', '8', '300')
  const recovered = quote('3000', '9', '300')
  mockQuote.mockResolvedValueOnce(original).mockResolvedValueOnce(recovered)
  expect(await getSwapQuote(request, settings)).toBe(recovered)
})

it('requotes a smaller input when the network fee rises instead of exceeding the budget', async () => {
  const original = quote('2600', '0', '700')
  const recovered = quote('2492', '1', '750')
  mockQuote
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(quote('2600', '1', '800'))
    .mockResolvedValueOnce(recovered)
  expect(await getSwapQuote(request, settings)).toBe(recovered)
  expect(mockQuote.mock.calls[2]?.[1]?.quoteRequest?.sellAmountAfterFee).toBe('2492')
})

it('does not replace a quote with a worse signed minimum', async () => {
  const original = quote('3000', '8', '300')
  const worse = quote('3000', '9', '300')
  worse.quoteResults.amountsAndCosts.amountsToSign.buyAmount = 1n
  mockQuote.mockResolvedValueOnce(original).mockResolvedValueOnce(worse)
  expect(await getSwapQuote(request, settings)).toBe(original)
})

it('retains the original when optional quote recovery fails', async () => {
  const original = quote('2600', '1', '700')
  mockQuote.mockResolvedValueOnce(original).mockRejectedValueOnce(new Error('unavailable'))
  expect(await getSwapQuote(request, settings)).toBe(original)
})

it('accepts the same output for less input', async () => {
  const original = quote('2600', '1', '700')
  const cheaper = quote('2600', '1', '650')
  mockQuote.mockResolvedValueOnce(original).mockResolvedValueOnce(cheaper)
  expect(await getSwapQuote(request, settings)).toBe(cheaper)
})

it('bounds retries when fees keep increasing', async () => {
  const original = quote('2600', '0', '700')
  mockQuote
    .mockResolvedValueOnce(original)
    .mockResolvedValueOnce(quote('2600', '1', '800'))
    .mockResolvedValueOnce(quote('2500', '1', '900'))
    .mockResolvedValueOnce(quote('2400', '1', '1000'))
  expect(await getSwapQuote(request, settings)).toBe(original)
  expect(mockQuote).toHaveBeenCalledTimes(4)
})

it.each([{ buyTokenDecimals: 18 }, { kind: OrderKind.BUY }, { buyTokenChainId: 100 }])(
  'leaves other quote flows unchanged: %j',
  async (overrides) => {
    const original = quote('2600', '1', '700')
    mockQuote.mockResolvedValueOnce(original)
    expect(await getSwapQuote({ ...request, ...overrides }, settings)).toBe(original)
    expect(mockQuote).toHaveBeenCalledTimes(1)
  },
)

it('keeps fast previews fast', async () => {
  const original = quote('2600', '0', '700')
  mockQuote.mockResolvedValueOnce(original)
  expect(await getSwapQuote(request, { quoteRequest: { priceQuality: PriceQuality.FAST } })).toBe(original)
  expect(mockQuote).toHaveBeenCalledTimes(1)
})
