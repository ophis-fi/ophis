import {
  CHAIN_INFO,
  getChainInfo,
  MONAD_CHAIN_ID,
  NATIVE_CURRENCY_ADDRESS,
  XLAYER_CHAIN_ID,
} from '@cowprotocol/common-const'
import { isEvmChain, TargetChainId } from '@cowprotocol/cow-sdk'

import { isRecipientAddress } from 'common/utils/recipientAddress.utils'

import {
  acrossBridgeProvider,
  bridgingSdk,
  bungeeBridgeProvider,
  nearIntentsBridgeProvider,
  setQuoteBridgeProviders,
} from './bridgingSdk'

const availableIds = (): string[] => bridgingSdk.getAvailableProviders().map((p) => p.info.dappId)

describe('bridgingSdk provider registry', () => {
  afterEach(() => {
    setQuoteBridgeProviders([acrossBridgeProvider.info.dappId, nearIntentsBridgeProvider.info.dappId])
  })

  it('advertises both quote providers plus the decode-only Bungee entry from boot', () => {
    expect(availableIds()).toEqual(
      expect.arrayContaining([
        acrossBridgeProvider.info.dappId,
        nearIntentsBridgeProvider.info.dappId,
        bungeeBridgeProvider.info.dappId,
      ]),
    )
  })

  it('keeps the decode-only Bungee entry when the quote set is narrowed (smart-contract wallets, flags)', () => {
    // BridgeProvidersUpdater narrows the quote set to NEAR only for smart-contract
    // wallets; getProviderFromAppData/getOrder search this same available list,
    // so historical Bungee orders must stay resolvable regardless.
    setQuoteBridgeProviders([nearIntentsBridgeProvider.info.dappId])

    expect(availableIds()).toEqual(
      expect.arrayContaining([nearIntentsBridgeProvider.info.dappId, bungeeBridgeProvider.info.dappId]),
    )
    expect(availableIds()).not.toContain(acrossBridgeProvider.info.dappId)
  })

  it('keeps the decode-only Bungee entry even with no quote provider at all', () => {
    setQuoteBridgeProviders([])

    expect(availableIds()).toEqual([bungeeBridgeProvider.info.dappId])
  })

  it('never lists Bungee first while a quote provider is enabled (single-quote path takes providers[0] ungated)', () => {
    expect(availableIds()[0]).not.toBe(bungeeBridgeProvider.info.dappId)

    setQuoteBridgeProviders([nearIntentsBridgeProvider.info.dappId])
    expect(availableIds()[0]).toBe(nearIntentsBridgeProvider.info.dappId)
  })

  it('registers Bungee as the decode-only subclass: no networks, no buy tokens, no API call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')

    expect(await bungeeBridgeProvider.getNetworks()).toEqual([])
    expect(await bungeeBridgeProvider.getBuyTokens({ buyChainId: 8453, sellChainId: 1 })).toEqual({
      tokens: [],
      isRouteAvailable: false,
    })
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })
})

describe('NEAR Intents destinations Ophis adds (Monad, X Layer)', () => {
  const nearToken = (blockchain: string, symbol: string, decimals: number, contractAddress?: string): object => ({
    assetId: `test:${blockchain}:${symbol}`,
    blockchain,
    symbol,
    decimals,
    contractAddress,
    price: 0,
    priceUpdatedAt: '2026-09-11T00:00:00Z',
  })

  it('registers both chains on the NEAR provider network list with the app cosmetics', async () => {
    const byId = new Map((await nearIntentsBridgeProvider.getNetworks()).map((n) => [n.id, n]))

    expect(byId.get(MONAD_CHAIN_ID)?.label).toBe('Monad')
    expect(byId.get(MONAD_CHAIN_ID)?.nativeCurrency.symbol).toBe('MON')
    expect(byId.get(XLAYER_CHAIN_ID)?.label).toBe('X Layer')
    expect(byId.get(XLAYER_CHAIN_ID)?.nativeCurrency.symbol).toBe('OKB')
  })

  it('maps NEAR tokens on those chains (native + ERC-20) to buy tokens', async () => {
    const api = (nearIntentsBridgeProvider as unknown as { api: { getTokens(): Promise<object[]> } }).api
    const spy = jest
      .spyOn(api, 'getTokens')
      .mockResolvedValue([
        nearToken('monad', 'MON', 18),
        nearToken('monad', 'USDC', 6, '0x754704bc059f8c67012fed69bc8a327a5aafb603'),
        nearToken('xlayer', 'OKB', 18),
        nearToken('eth', 'USDC', 6, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
      ])

    const monad = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: MONAD_CHAIN_ID as TargetChainId })
    expect(monad.isRouteAvailable).toBe(true)
    expect(monad.tokens.map((t) => t.symbol).sort()).toEqual(['MON', 'USDC'])
    expect(monad.tokens.find((t) => t.symbol === 'MON')?.address.toLowerCase()).toBe(
      NATIVE_CURRENCY_ADDRESS.toLowerCase(),
    )

    const xlayer = await nearIntentsBridgeProvider.getBuyTokens({ buyChainId: XLAYER_CHAIN_ID as TargetChainId })
    expect(xlayer.tokens.map((t) => t.symbol)).toEqual(['OKB'])
    spy.mockRestore()
  })

  it('treats them as EVM chains for addresses, outside the trading chain map', () => {
    expect(isEvmChain(MONAD_CHAIN_ID)).toBe(true)
    expect(isEvmChain(XLAYER_CHAIN_ID)).toBe(true)
    // Not trading chains: the explorer derives its network routes from CHAIN_INFO.
    expect(CHAIN_INFO[MONAD_CHAIN_ID as TargetChainId]).toBeUndefined()
    expect(getChainInfo(MONAD_CHAIN_ID as TargetChainId).label).toBe('Monad')
    expect(isRecipientAddress('0x3F92Ac7B4f2ad492D7ADe1bdDf5003922F21331b', MONAD_CHAIN_ID)).toBe(true)
  })
})
