import { OrderKind, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, BridgingSdk, BridgeStatus, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import chains from './fixtures/chains.json'
import sample from './fixtures/usdc-base-optimism.json'
import { RelayBridgeProvider } from './relayBridgeProvider.service'
import { isRelayRecoveryRequired } from './relayStatus.service'

jest.mock('@cowprotocol/sdk-cow-shed', () => ({
  CowShedSdk: jest.fn(() => ({ getCowShedAccount: () => '0x2222222222222222222222222222222222222222' })),
}))
jest.mock('@cowprotocol/cow-sdk', () => ({
  ...jest.requireActual('@cowprotocol/cow-sdk'),
  getGlobalAdapter: () => ({}),
}))
jest.mock('./relayProgram.service', () => ({
  relayProgram: (terms: unknown) => ({
    terms,
    call: { to: '0x2222222222222222222222222222222222222222', data: '0x1234', value: 0n },
  }),
}))

const tokens = [
  { chainId: 8453, address: sample.request.originCurrency, decimals: 6, symbol: 'USDC' },
  { chainId: 10, address: sample.request.destinationCurrency, decimals: 6, symbol: 'USDC' },
]
const request: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  amount: BigInt(sample.request.amount),
  account: sample.request.user,
  sellTokenChainId: SupportedChainId.BASE,
  sellTokenAddress: sample.request.originCurrency,
  sellTokenDecimals: 6,
  buyTokenChainId: 10 as SupportedChainId,
  buyTokenAddress: sample.request.destinationCurrency,
  buyTokenDecimals: 6,
}
const provider = (enabled = true): RelayBridgeProvider =>
  new RelayBridgeProvider({ enabled, trustedTokens: async () => tokens, sourceChainIds: new Set([8453]) })

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-13T12:00:00Z'))
  global.fetch = jest.fn(async (input) => ({
    ok: true,
    json: async () => (String(input).endsWith('/chains') ? chains : sample.response),
  })) as jest.Mock
})
afterEach(() => jest.restoreAllMocks())

it('disabled provider makes no discovery requests and remains usable for history', async () => {
  const trustedTokens = jest.fn(async () => tokens)
  const disabled = new RelayBridgeProvider({ enabled: false, trustedTokens, sourceChainIds: new Set([8453]) })
  expect(await disabled.getNetworks()).toEqual([])
  expect(await disabled.getBuyTokens({ buyChainId: 10 as SupportedChainId, sellChainId: 8453 })).toEqual({
    tokens: [],
    isRouteAvailable: false,
  })
  expect(fetch).not.toHaveBeenCalled()
  expect(trustedTokens).not.toHaveBeenCalled()
})

it('returns only trusted same-asset intermediate tokens and refuses unproved sources', async () => {
  const relay = provider()
  expect(await relay.getIntermediateTokens(request)).toEqual([
    expect.objectContaining({ address: sample.request.originCurrency }),
  ])
  expect(await relay.getIntermediateTokens({ ...request, sellTokenChainId: SupportedChainId.GNOSIS_CHAIN })).toEqual([])
  expect(
    await relay.getIntermediateTokens({ ...request, buyTokenAddress: '0x4242424242424242424242424242424242424242' }),
  ).toEqual([])
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('returns destination native ETH through WETH without asking Relay to perform a swap', async () => {
  const relay = provider()
  const result = await relay.getIntermediateTokens({
    ...request,
    buyTokenAddress: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
    buyTokenDecimals: 18,
  })
  expect(result).toEqual([expect.objectContaining({ address: '0x4200000000000000000000000000000000000006' })])
})

it('compares net destination output, including the app fee, and refunds to the owner', async () => {
  const quote = await provider().getQuote(request)
  expect(quote.amountsAndCosts.afterSlippage.buyAmount).toBe(9_966_020n)
  expect(quote.amountsAndCosts.afterFee.buyAmount).toBe(9_975_995n)
  expect(quote.id).toBe(sample.response.requestId)
  const sent = JSON.parse((fetch as jest.Mock).mock.calls[1][1].body)
  expect(sent.user).toBe('0x2222222222222222222222222222222222222222')
  expect(sent.refundTo).toBe(request.account)
  expect(JSON.parse(quote.quoteBody || '{}').request.signer).toBeUndefined()
})

it('an unavailable Relay discovery endpoint leaves other providers free to quote', async () => {
  ;(fetch as jest.Mock).mockRejectedValue(new Error('network down'))
  expect(await provider().getNetworks()).toEqual([])
})

it.each(['to', 'data', 'value'])(
  'rejects in-place changes to unsigned call %s before any signing callback',
  async (field) => {
    const signHook = jest.fn()
    const relay = new RelayBridgeProvider({
      enabled: true,
      trustedTokens: async () => tokens,
      sourceChainIds: new Set([8453]),
      signHook,
    })
    const quote = await relay.getQuote(request)
    const call = await relay.getUnsignedBridgeCall(request, quote)
    Object.assign(call, { [field]: field === 'value' ? 1n : '0x4242424242424242424242424242424242424242' })
    await expect(relay.getSignedHook(8453, call, `0x${'aa'.repeat(32)}`, 1n, 1_200_000)).rejects.toThrow()
    expect(signHook).not.toHaveBeenCalled()
  },
)

it.each([
  ['waiting', undefined, BridgeStatus.IN_PROGRESS],
  ['failure', undefined, BridgeStatus.IN_PROGRESS],
  ['success', undefined, BridgeStatus.UNKNOWN],
  ['success', [`0x${'aa'.repeat(32)}`], BridgeStatus.EXECUTED],
  ['refund', [`0x${'bb'.repeat(32)}`], BridgeStatus.REFUND],
  ['unexpected', undefined, BridgeStatus.UNKNOWN],
])('maps Relay %s with tx hashes %s to %s', async (status, txHashes, expected) => {
  ;(fetch as jest.Mock).mockResolvedValue({ ok: true, json: async () => ({ status, txHashes }) })
  expect((await provider(false).getStatus(sample.response.requestId, SupportedChainId.BASE)).status).toBe(expected)
})

it('keeps a manual-refund failure unresolved instead of claiming the funds were refunded', async () => {
  ;(fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: async () => ({ status: 'failure', refundFailReason: 'MANUAL_REFUND_REQUIRED' }),
  })
  const result = await provider(false).getStatus(sample.response.requestId, SupportedChainId.BASE)
  expect(result.status).toBe(BridgeStatus.UNKNOWN)
  expect(isRelayRecoveryRequired(result)).toBe(true)
})

it('a stalled Relay request cannot exhaust the SDK timeout for other providers', async () => {
  jest.useFakeTimers()
  ;(fetch as jest.Mock).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  )
  const healthy = new AcrossBridgeProvider()
  jest.spyOn(healthy, 'getBuyTokens').mockResolvedValue({ tokens: [tokens[1]], isRouteAvailable: true })
  const sdk = new BridgingSdk({ providers: [healthy, provider()], cacheConfig: { enabled: false } })
  const result = sdk.getBuyTokens({ buyChainId: 10 as SupportedChainId, sellChainId: 8453 })
  await jest.advanceTimersByTimeAsync(3_001)
  expect((await result).tokens).toEqual([tokens[1]])
  jest.useRealTimers()
})
