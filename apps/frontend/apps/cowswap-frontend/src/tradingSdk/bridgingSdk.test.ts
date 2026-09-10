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
})
