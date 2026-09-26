import { BRIDGE_SOURCE_CHAIN_IDS, NATIVE_CURRENCY_ADDRESS } from '@cowprotocol/common-const'
import { OrderKind, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'
import { BridgeQuoteErrors, QuoteBridgeRequest } from '@cowprotocol/sdk-bridging'

import { getAddress, type Hex } from 'viem'

import { NearQuoteResponse, OphisNearIntentsBridgeProvider } from './ophisNearIntentsProvider.service'

const ROBINHOOD = 4663 as TargetChainId
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'

// Real, unfunded hood USDG -> Base USDC quote and deposit attestation from
// 2026-09-22. Replay the signed payload offline; no production signing key.
const QUOTE_RESPONSE = {
  quote: {
    amountIn: '100000000',
    amountInFormatted: '100.0',
    amountInUsd: '99.998200000000',
    minAmountIn: '99000000',
    amountOut: '99574751',
    amountOutFormatted: '99.574751',
    amountOutUsd: '99.553939877041',
    minAmountOut: '98579003',
    timeEstimate: 1827,
    refundFee: '75000',
    withdrawFee: '2400',
    deadline: '2026-09-25T11:37:50.567Z',
    timeWhenInactive: '2026-09-25T11:37:50.567Z',
    depositAddress: '0xf70CadC970C60De6b3cC32eDd9080A720DeeCBe2',
  },
  quoteRequest: {
    dry: false,
    depositMode: 'SIMPLE',
    swapType: 'FLEX_INPUT',
    slippageTolerance: 100,
    originAsset: 'nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near',
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    amount: '100000000',
    refundTo: '0x1111111111111111111111111111111111111111',
    refundType: 'ORIGIN_CHAIN',
    recipient: '0x1111111111111111111111111111111111111111',
    recipientType: 'DESTINATION_CHAIN',
    deadline: '2026-09-22T11:37:50.567Z',
    confidentiality: 'public',
    referral: 'ophis',
    quoteWaitingTimeMs: 0,
    appFees: [
      {
        recipient: '0x858f0F5eE954846D47155F5203c04aF1819eCeF8',
        fee: 3,
      },
      {
        recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd',
        fee: 25,
      },
    ],
    insured: false,
  },
  signature: 'ed25519:3V9PwF55PRz1yTLoVG7a7d2nEboD2qPVHWyMWjWfWYCDcFCdLawStiMHPGmnahQfMyrcWFehajAbNXwqG9Kbx3FQ',
  timestamp: '2026-09-22T10:37:50.707Z',
  correlationId: '7eefdfd1-42c1-4592-9a19-1afbdb826b8a',
} as NearQuoteResponse
const ATTESTATION = {
  signature:
    '0x1e2b7a54cf8536b607d348b14d9a7ab171a3c18aff84625cdec9e0a510b02ce27eb6ca3783ddaabb488a50a218e7ad772bac505b78720ad3c8893611767154271b',
  version: 0,
} as const

class TestableNearProvider extends OphisNearIntentsBridgeProvider {
  get testApi(): OphisNearIntentsBridgeProvider['api'] {
    return this.api
  }
}

type NearToken = Awaited<ReturnType<TestableNearProvider['testApi']['getTokens']>>[number]
const TOKENS = [
  {
    blockchain: 'hood',
    symbol: 'USDG',
    decimals: 6,
    contractAddress: USDG,
    assetId: QUOTE_RESPONSE.quoteRequest.originAsset,
  },
  { blockchain: 'hood', symbol: 'ETH', decimals: 18, assetId: 'nep141:hood.omft.near' },
  {
    blockchain: 'base',
    symbol: 'USDC',
    decimals: 6,
    contractAddress: BASE_USDC,
    assetId: QUOTE_RESPONSE.quoteRequest.destinationAsset,
  },
] as NearToken[]
const REQUEST: QuoteBridgeRequest = {
  kind: OrderKind.SELL,
  amount: 100_000_000n,
  sellTokenChainId: ROBINHOOD as SupportedChainId,
  sellTokenAddress: USDG,
  sellTokenDecimals: 6,
  buyTokenChainId: SupportedChainId.BASE,
  buyTokenAddress: BASE_USDC,
  buyTokenDecimals: 6,
  account: getAddress(QUOTE_RESPONSE.quoteRequest.refundTo) as Hex,
  receiver: QUOTE_RESPONSE.quoteRequest.recipient,
  appCode: 'test',
}

describe('NEAR Robinhood routes', () => {
  const provider = new TestableNearProvider()
  beforeEach(() => {
    jest.spyOn(provider.testApi, 'getTokens').mockResolvedValue(TOKENS)
    jest.spyOn(provider.testApi, 'getQuote').mockResolvedValue(QUOTE_RESPONSE)
    jest.spyOn(provider.testApi, 'getAttestation').mockResolvedValue(ATTESTATION)
  })
  afterEach(() => jest.restoreAllMocks())

  it('registers hood once and exposes native ETH plus ERC-20s in both directions', async () => {
    new TestableNearProvider()
    expect((await provider.getNetworks()).filter(({ id }) => id === ROBINHOOD)).toHaveLength(1)
    expect(BRIDGE_SOURCE_CHAIN_IDS.has(ROBINHOOD)).toBe(true)
    const inbound = await provider.getBuyTokens({ sellChainId: SupportedChainId.BASE, buyChainId: ROBINHOOD })
    expect(inbound.isRouteAvailable).toBe(true)
    expect(inbound.tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chainId: ROBINHOOD, address: USDG, symbol: 'USDG' }),
        expect.objectContaining({ chainId: ROBINHOOD, address: NATIVE_CURRENCY_ADDRESS, symbol: 'ETH' }),
      ]),
    )
    expect(
      (await provider.getBuyTokens({ sellChainId: ROBINHOOD as SupportedChainId, buyChainId: SupportedChainId.BASE }))
        .isRouteAvailable,
    ).toBe(true)
    expect(await provider.getIntermediateTokens(REQUEST)).toEqual(
      expect.arrayContaining([expect.objectContaining({ chainId: ROBINHOOD, address: USDG })]),
    )
  })

  it('accepts the real attestation and uses its deposit address as the order receiver', async () => {
    const quote = await provider.getQuote(REQUEST)
    expect(provider.testApi.getQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        originAsset: QUOTE_RESPONSE.quoteRequest.originAsset,
        destinationAsset: QUOTE_RESPONSE.quoteRequest.destinationAsset,
        swapType: 'FLEX_INPUT',
      }),
    )
    expect(quote.attestationSignature).toBe(ATTESTATION.signature)
    expect(quote.id).toBe('0xeed5a17488d0e8b5fca84693d5c671ac5d4ae1ec2a10b0478506a4fcbcc8c39f')
    expect(await provider.getBridgeReceiverOverride(REQUEST, quote)).toBe(QUOTE_RESPONSE.quote.depositAddress)
  })

  it.each([
    { ...QUOTE_RESPONSE, quote: { ...QUOTE_RESPONSE.quote, depositAddress: REQUEST.account } },
    { ...QUOTE_RESPONSE, quote: { ...QUOTE_RESPONSE.quote, amountOut: '999999999' } },
    { ...QUOTE_RESPONSE, quoteRequest: { ...QUOTE_RESPONSE.quoteRequest, recipient: USDG } },
  ])('rejects a changed deposit address, amount or recipient under the original attestation', async (changed) => {
    jest.spyOn(provider.testApi, 'getQuote').mockResolvedValue(changed)
    await expect(provider.getQuote(REQUEST)).rejects.toThrow(BridgeQuoteErrors.QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS)
  })

  it('rejects a malformed attestation', async () => {
    jest.spyOn(provider.testApi, 'getAttestation').mockResolvedValue({ signature: '0x00', version: 0 })
    await expect(provider.getQuote(REQUEST)).rejects.toThrow(BridgeQuoteErrors.QUOTE_DOES_NOT_MATCH_DEPOSIT_ADDRESS)
  })
})
