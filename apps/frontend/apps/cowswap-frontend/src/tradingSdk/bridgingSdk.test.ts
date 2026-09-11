import {
  CHAIN_INFO,
  getChainInfo,
  isBridgeOnlyDestinationChain,
  MONAD_CHAIN_ID,
  NATIVE_CURRENCIES,
  NATIVE_CURRENCY_ADDRESS,
  SORTED_DST_CHAIN_IDS,
  toBridgeChainInfo,
  XLAYER_CHAIN_ID,
} from '@cowprotocol/common-const'
import { ExplorerDataType, getExplorerLink, getIsNativeToken, getWrappedToken } from '@cowprotocol/common-utils'
import { isEvmChain, SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'

// eslint-disable-next-line import/no-internal-modules -- pure util under test, not part of the module's index
import { filterDestinationChains } from 'modules/tokensList/utils/chainsState'

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

  it('reaches the destination picker: ordered list, provider-network filter, native semantics (Codex on #1388)', () => {
    // The picker is fed by SORTED_DST_CHAIN_IDS and filterDestinationChains, not
    // by the provider registration alone.
    expect(SORTED_DST_CHAIN_IDS).toEqual(expect.arrayContaining([MONAD_CHAIN_ID, XLAYER_CHAIN_ID]))
    const kept = filterDestinationChains([toBridgeChainInfo(MONAD_CHAIN_ID), toBridgeChainInfo(XLAYER_CHAIN_ID)])
    expect(kept?.map((c) => c.id)).toEqual([MONAD_CHAIN_ID, XLAYER_CHAIN_ID])
    // Native MON / OKB at the sentinel address are native, not ERC-20s.
    expect(getIsNativeToken(MONAD_CHAIN_ID as SupportedChainId, NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(getIsNativeToken(XLAYER_CHAIN_ID as SupportedChainId, NATIVE_CURRENCY_ADDRESS)).toBe(true)
    expect(getChainInfo(XLAYER_CHAIN_ID as TargetChainId).nativeCurrency.symbol).toBe('OKB')
  })

  it('carries wrapped twins, native explorer links and the shared destination predicate (Codex round 2)', () => {
    // getWrappedToken() maps a native output through WRAPPED_NATIVE_CURRENCIES
    // (USD value, price impact, approval preview).
    expect(getWrappedToken(NATIVE_CURRENCIES[MONAD_CHAIN_ID as TargetChainId]).symbol).toBe('WMON')
    expect(getWrappedToken(NATIVE_CURRENCIES[XLAYER_CHAIN_ID as TargetChainId]).symbol).toBe('WOKB')
    // No Ophis explorer route for these chains: link to their native explorer.
    const addr = '0x3F92Ac7B4f2ad492D7ADe1bdDf5003922F21331b'
    expect(getExplorerLink(MONAD_CHAIN_ID, addr, ExplorerDataType.ADDRESS)).toBe(
      `https://monadscan.com/address/${addr}`,
    )
    expect(getExplorerLink(XLAYER_CHAIN_ID, addr, ExplorerDataType.ADDRESS)).toBe(
      `https://www.oklink.com/xlayer/address/${addr}`,
    )
    // One predicate for the picker filter and the invalid-output updater.
    expect(isBridgeOnlyDestinationChain(MONAD_CHAIN_ID)).toBe(true)
    expect(isBridgeOnlyDestinationChain(XLAYER_CHAIN_ID)).toBe(true)
    expect(isBridgeOnlyDestinationChain(SupportedChainId.MAINNET)).toBe(false)
    expect(isBridgeOnlyDestinationChain(undefined)).toBe(false)
  })
})
