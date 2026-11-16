import { OrderBookApi, OrderKind, PriceQuality, setGlobalAdapter, SigningScheme } from '@cowprotocol/cow-sdk'
import { BridgeQuoteResults, MultiQuoteRequest, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'
import { getQuote, postSwapOrderFromQuote } from '@cowprotocol/sdk-trading'

import { Wallet, utils, providers } from 'ethers'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'

import { doQuotePolling } from './doQuotePolling'
import { fetchAndProcessQuote } from './fetchAndProcessQuote'

import { TradeQuoteManager } from '../hooks/useTradeQuoteManager'
import { DEFAULT_TRADE_QUOTE_STATE } from '../state/tradeQuoteAtom'

jest.mock('tradingSdk/bridgingSdk', () => ({ bridgingSdk: { getBestQuote: jest.fn() } }))
jest.mock('../utils/getBridgeQuoteSigner', () => ({ getBridgeQuoteSigner: jest.fn() }))

// Public, unfunded local identity; PRESIGN never requests a signature or a transaction.
const wallet = new Wallet(utils.keccak256(utils.toUtf8Bytes('ophis-bridge-slippage-regression')))
const account = wallet.address as `0x${string}`
const sellToken = '0x4200000000000000000000000000000000000006'
const buyToken = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const appData = { version: '1.3.0', appCode: 'test', metadata: { quote: { slippageBips: 300 } } }
const sendOrder = jest.fn(async () => 'local-order')
const api = {
  context: { chainId: 8453, env: 'prod' },
  getQuote: async (request: { from: string; appDataHash: string }) => ({
    id: 123,
    expiration: new Date(Date.now() + 60_000).toISOString(),
    quote: {
      sellToken,
      buyToken,
      receiver: request.from,
      sellAmount: '10000000',
      buyAmount: '10050251',
      feeAmount: '0',
      validTo: Math.floor(Date.now() / 1000) + 300,
      kind: 'sell',
      partiallyFillable: false,
      appData: request.appDataHash,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    },
  }),
  uploadAppData: async () => {},
  sendOrder,
} as unknown as OrderBookApi
const request: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  amount: 10_000_000n,
  account,
  owner: account,
  appCode: 'test',
  sellTokenChainId: 8453,
  sellTokenAddress: sellToken,
  sellTokenDecimals: 18,
  buyTokenChainId: 10,
  buyTokenAddress: buyToken,
  buyTokenDecimals: 6,
}

async function quote(
  doc: NonNullable<Parameters<typeof fetchAndProcessQuote>[3]> = appData,
): Promise<{ manager: TradeQuoteManager; bridgeInput: bigint }> {
  const adapter = new EthersV5Adapter({
    signer: wallet,
    provider: new providers.StaticJsonRpcProvider('http://127.0.0.1:1', 8453),
  })
  setGlobalAdapter(adapter)
  let bridgeInput = 0n
  jest.mocked(bridgingSdk.getBestQuote).mockImplementation(async (params: MultiQuoteRequest) => {
    const { result } = await getQuote(
      {
        owner: account,
        amount: '10000000',
        kind: OrderKind.SELL,
        sellToken,
        buyToken,
        sellTokenDecimals: 18,
        buyTokenDecimals: 6,
        slippageBps: params.quoteBridgeRequest.swapSlippageBps,
      },
      { chainId: 8453, account, appCode: 'test' },
      params.advancedSettings,
      api,
    )
    bridgeInput = result.amountsAndCosts.afterSlippage.buyAmount
    const bridgeQuote = {
      providerDappId: 'test',
      quote: {
        swap: result,
        bridge: { tradeParameters: request } as BridgeQuoteResults,
        postSwapOrderFromQuote: (settings: Parameters<typeof postSwapOrderFromQuote>[1]) =>
          postSwapOrderFromQuote({ result: { ...result, signer: adapter.signer }, orderBookApi: api }, settings),
      },
    }
    params.options?.onQuoteResult?.(bridgeQuote)
    return bridgeQuote
  })
  const manager = {
    setLoading: jest.fn(),
    onResponse: jest.fn(),
    onError: jest.fn(),
    reset: jest.fn(),
    expire: jest.fn(),
    resetTracking: jest.fn(),
  }
  await fetchAndProcessQuote(
    { hasParamsChanged: true, priceQuality: PriceQuality.OPTIMAL, fetchStartTimestamp: Date.now() },
    request,
    { isConfirmOpen: false, isQuoteUpdatePossible: true, useSuggestedSlippageApi: false },
    doc,
    manager,
  )
  expect(manager.onError).not.toHaveBeenCalled()
  return { manager, bridgeInput }
}

beforeEach(() => sendOrder.mockClear())

it('funds a bridge with the minimum that the actual SDK posts for custom default slippage', async () => {
  const { manager, bridgeInput } = await quote()
  const quoted = jest.mocked(manager.onResponse).mock.calls[0][0]
  await quoted.postSwapOrderFromQuote({ appData, additionalParams: { signingScheme: SigningScheme.PRESIGN } })
  expect(bridgeInput).toBe(9_748_744n)
  expect(sendOrder).toHaveBeenCalledWith(expect.objectContaining({ buyAmount: String(bridgeInput) }))
})

it('refuses changed slippage before forwarding placement to the SDK', async () => {
  const { manager } = await quote()
  const quoted = jest.mocked(manager.onResponse).mock.calls[0][0]
  expect(() =>
    quoted.postSwapOrderFromQuote({
      appData: { ...appData, metadata: { quote: { slippageBips: 500 } } },
      additionalParams: { signingScheme: SigningScheme.PRESIGN },
    }),
  ).toThrow('Slippage changed')
  expect(sendOrder).not.toHaveBeenCalled()
})

it.each([100, 0])(
  'requotes cached smart-slippage bridges at %s bps and signs the newly funded minimum',
  async (bps) => {
    const { manager } = await quote({ ...appData, metadata: { quote: { slippageBips: 50 } } })
    const [previous, bridgeQuote] = jest.mocked(manager.onResponse).mock.calls[0]
    const currentDoc = previous.quoteResults.appDataInfo.doc
    const updatedDoc = { ...currentDoc, metadata: { ...currentDoc.metadata, quote: { slippageBips: bps } } }
    const context = {
      currentQuote: { ...DEFAULT_TRADE_QUOTE_STATE, quote: previous, bridgeQuote },
      quoteParams: request,
      appData: currentDoc,
      hasSmartSlippage: true,
      fetchQuote: jest.fn(),
      hasParamsChanged: true,
      forceUpdate: false,
      isBrowserOnline: true,
      isConfirmOpen: false,
    }
    expect(doQuotePolling(context)).toBe(false)
    expect(doQuotePolling({ ...context, appData: updatedDoc })).toBe(true)
    expect(context.fetchQuote).toHaveBeenCalledTimes(1)
    expect(
      doQuotePolling({
        ...context,
        currentQuote: { ...context.currentQuote, bridgeQuote: null },
        quoteParams: { ...request, buyTokenChainId: 8453, validFor: previous.quoteResults.tradeParameters.validFor },
        appData: updatedDoc,
      }),
    ).toBe(false)

    const next = await quote(updatedDoc)
    const [refreshed] = jest.mocked(next.manager.onResponse).mock.calls[0]
    await refreshed.postSwapOrderFromQuote({
      appData: updatedDoc,
      additionalParams: { signingScheme: SigningScheme.PRESIGN },
    })
    expect(sendOrder).toHaveBeenCalledWith(expect.objectContaining({ buyAmount: String(next.bridgeInput) }))
  },
)
