import { ARC_CHAIN_ID, ARC_USDC_ADDRESS, ARC_ENABLED } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, TokenInfo } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, BridgeStatus, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { ARC_BRIDGE_CHAIN } from './ophisBridgeChains'
import { ACROSS_EXECUTABLE_SOURCE_IDS, OphisAcrossBridgeProvider } from './ophisBridgeProviders'

class TestAcross extends OphisAcrossBridgeProvider {
  get tokensApi(): { getSupportedTokens(): Promise<TokenInfo[]> } {
    return this.api
  }
}

afterEach(() => jest.restoreAllMocks())

it('keeps a requested slow fill pending until the destination fill arrives', async () => {
  const provider = new TestAcross()
  jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'slowFillRequested' }) } as Response)
    .mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'filled', fillTx: '0xabc' }) } as Response)
  expect((await provider.getStatus('123', SupportedChainId.BASE)).status).toBe(BridgeStatus.IN_PROGRESS)
  expect(await provider.getStatus('123', SupportedChainId.BASE)).toMatchObject({
    status: BridgeStatus.EXECUTED,
    fillTxHash: '0xabc',
  })
})

it('bridges six-decimal USDC into Arc through an executable source, never out of Arc', async () => {
  expect(ARC_BRIDGE_CHAIN.id).toBe(5042)
  expect(ARC_BRIDGE_CHAIN.nativeCurrency.decimals).toBe(18)
  expect(ACROSS_EXECUTABLE_SOURCE_IDS.has(ARC_CHAIN_ID)).toBe(false)
  const provider = new TestAcross()
  expect((await provider.getNetworks()).some((chain) => chain.id === ARC_CHAIN_ID)).toBe(ARC_ENABLED)
  const input: TokenInfo = {
    chainId: 8453,
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    symbol: 'USDC',
    decimals: 6,
  }
  const request = {
    kind: OrderKind.SELL,
    sellTokenChainId: SupportedChainId.BASE,
    buyTokenChainId: ARC_CHAIN_ID,
    buyTokenAddress: ARC_USDC_ADDRESS,
    sellTokenDecimals: 6,
    buyTokenDecimals: 6,
    amount: 10_000_000n,
  } as QuoteBridgeRequest
  jest.spyOn(AcrossBridgeProvider.prototype, 'getIntermediateTokens').mockResolvedValue([])
  jest.spyOn(provider.tokensApi, 'getSupportedTokens').mockResolvedValue([input])
  // Recorded shape of Across available-routes; no RPC or bridge transaction.
  const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => [
      {
        originChainId: 8453,
        originToken: input.address,
        originTokenSymbol: 'USDC',
        destinationChainId: 5042,
        destinationToken: ARC_USDC_ADDRESS,
        destinationTokenSymbol: 'USDC',
        isNative: false,
      },
    ],
  } as Response)
  expect(await provider.getIntermediateTokens(request)).toEqual([input])
  expect(fetchSpy).toHaveBeenCalledTimes(1)
  expect(await provider.getBuyTokens({ sellChainId: ARC_CHAIN_ID, buyChainId: SupportedChainId.BASE })).toEqual({
    tokens: [],
    isRouteAvailable: false,
  })
  await expect(provider.getQuote({ ...request, buyTokenDecimals: 18 })).rejects.toThrow()
})

it('quotes Base USDC to Arc USDC with both token addresses and correct output units', async () => {
  const fees = {
    estimatedFillTimeSec: 2,
    timestamp: '1790090000',
    isAmountTooLow: false,
    quoteBlock: '123',
    spokePoolAddress: '0x5290E9582B4FB706EaDf87BB1c129e897e04C06D',
    exclusiveRelayer: '0x0000000000000000000000000000000000000000',
    exclusivityDeadline: 0,
    fillDeadline: '1790093600',
    totalRelayFee: { pct: '1000000000000000', total: '100000' },
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
  const quote = await new OphisAcrossBridgeProvider().getQuote({
    kind: OrderKind.SELL,
    sellTokenChainId: SupportedChainId.BASE,
    buyTokenChainId: ARC_CHAIN_ID,
    sellTokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    buyTokenAddress: ARC_USDC_ADDRESS,
    sellTokenDecimals: 6,
    buyTokenDecimals: 6,
    amount: 100_000_000n,
  } as QuoteBridgeRequest)
  const url = new URL(String(fetchSpy.mock.calls[0]?.[0]))
  expect(url.searchParams.get('originChainId')).toBe('8453')
  expect(url.searchParams.get('destinationChainId')).toBe('5042')
  expect(url.searchParams.get('outputToken')).toBe(ARC_USDC_ADDRESS)
  expect(quote.amountsAndCosts.afterFee.buyAmount).toBe(99_900_000n)
})
