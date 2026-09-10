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
