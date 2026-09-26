import { ARC_CHAIN_ID } from '@cowprotocol/common-const'
import { getQuoteWithoutSigner, OrderKind, OrderBookApi, type QuoteResults } from '@cowprotocol/cow-sdk'
import { Token } from '@cowprotocol/currency'

import { WBTC_ETHEREUM } from 'entities/cctp'
import { OPHIS_PARTNER_FEE_RECIPIENT } from 'ophis/partnerFeeDefault'

import { type QuoteParams } from 'modules/tradeQuote'

import { quoteBtcSwap } from './btcSwapQuote.service'
import { quoteCctp } from './cctp.service'
import { cctpToken } from './cctpAssets.const'

jest.mock('@cowprotocol/cow-sdk', () => ({
  ...jest.requireActual('@cowprotocol/cow-sdk'),
  getQuoteWithoutSigner: jest.fn(),
}))
jest.mock('./cctp.service', () => ({ ...jest.requireActual('./cctp.service'), quoteCctp: jest.fn() }))
const owner = '0x0000000000000000000000000000000000000001'
const params: QuoteParams = {
  inputCurrency: new Token(1, WBTC_ETHEREUM, 8),
  appData: {
    version: '1.13.0',
    appCode: 'Ophis',
    metadata: { partnerFee: { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT } },
  },
  quoteParams: {
    kind: OrderKind.SELL,
    amount: 1000000n,
    owner,
    account: owner,
    sellTokenChainId: 1,
    buyTokenChainId: ARC_CHAIN_ID,
    sellTokenAddress: WBTC_ETHEREUM,
    buyTokenAddress: cctpToken(5042, 'cirBTC'),
    sellTokenDecimals: 8,
    buyTokenDecimals: 8,
    swapSlippageBps: 25,
    appCode: 'Ophis',
    partnerFee: { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
  } as QuoteParams['quoteParams'],
}
const order = {
  sellToken: WBTC_ETHEREUM,
  buyToken: cctpToken(1, 'cirBTC'),
  receiver: owner,
  sellAmount: '1000000',
  buyAmount: '995000',
  feeAmount: '0',
  validTo: 1800000000,
  partiallyFillable: false,
  kind: OrderKind.SELL,
}
beforeEach(() => {
  jest.resetAllMocks()
  jest
    .mocked(getQuoteWithoutSigner)
    .mockResolvedValue({ result: { orderToSign: order } as QuoteResults } as Awaited<
      ReturnType<typeof getQuoteWithoutSigner>
    >)
  jest.mocked(quoteCctp).mockResolvedValue({
    source: 1,
    destination: 5042,
    owner,
    amount: '995000',
    maxFee: '0',
    asset: 'cirBTC',
    quotedAt: Date.now(),
  })
})

it('quotes the source swap on a fixed Ethereum API and preserves fee, appData, slippage and self recipient', async () => {
  expect(OPHIS_PARTNER_FEE_RECIPIENT).toBe('0x858f0F5eE954846D47155F5203c04aF1819eCeF8')
  await quoteBtcSwap(params, owner, '0.01')
  expect(getQuoteWithoutSigner).toHaveBeenCalledWith(
    expect.objectContaining({
      owner,
      receiver: owner,
      buyToken: cctpToken(1, 'cirBTC'),
      partiallyFillable: false,
      validFor: 300,
      slippageBps: 25,
      partnerFee: params.quoteParams?.partnerFee,
    }),
    expect.objectContaining({ chainId: 1, account: owner }),
    expect.objectContaining({ appData: params.appData }),
    expect.any(OrderBookApi),
  )
  expect(quoteCctp).toHaveBeenCalledWith(1, 5042, owner, '0.00995', 'cirBTC')
})

it('rejects stale inputs, other recipients, noncanonical assets, buy orders and excessive slippage before quoting', async () => {
  for (const patch of [
    { amount: 1n },
    { receiver: WBTC_ETHEREUM },
    { buyTokenAddress: WBTC_ETHEREUM },
    { kind: OrderKind.BUY },
    { swapSlippageBps: 501 },
    { sellTokenDecimals: 18 },
  ]) {
    await expect(
      quoteBtcSwap(
        { ...params, quoteParams: { ...params.quoteParams, ...patch } as QuoteParams['quoteParams'] },
        owner,
        '0.01',
      ),
    ).rejects.toThrow('Review the route')
  }
  expect(getQuoteWithoutSigner).not.toHaveBeenCalled()
})

it('does not offer a swap with the wrong receiver, excessive loss or a different input amount', async () => {
  for (const patch of [{ receiver: WBTC_ETHEREUM }, { buyAmount: '900000' }, { sellAmount: '999999' }]) {
    jest
      .mocked(getQuoteWithoutSigner)
      .mockResolvedValueOnce({ result: { orderToSign: { ...order, ...patch } } } as Awaited<
        ReturnType<typeof getQuoteWithoutSigner>
      >)
    await expect(quoteBtcSwap(params, owner, '0.01')).rejects.toThrow('No acceptable')
  }
  expect(quoteCctp).not.toHaveBeenCalled()
})
