import { Provider } from 'jotai'
import { createStore } from 'jotai/vanilla'

import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { useIsSmartContractWallet } from '@cowprotocol/wallet'

import { render } from '@testing-library/react'
import {
  acrossBridgeProvider,
  bridgingSdk,
  nearIntentsBridgeProvider,
  relayBridgeProvider,
} from 'tradingSdk/bridgingSdk'

import { bridgeProvidersAtom } from './bridgeProvidersAtom'
import { BridgeProvidersUpdater } from './BridgeProvidersUpdater'

jest.mock('@cowprotocol/common-const', () => ({
  ...jest.requireActual('@cowprotocol/common-const'),
  RELAY_ENABLED: true,
}))
jest.mock('@cowprotocol/common-hooks', () => ({ useFeatureFlags: jest.fn() }))
jest.mock('@cowprotocol/wallet', () => ({ useIsSmartContractWallet: jest.fn() }))

afterEach(() => jest.restoreAllMocks())

it.each([undefined, true])('keeps smart wallets NEAR-only with flags %s and restores EOA providers', (flag) => {
  jest.mocked(useFeatureFlags).mockReturnValue({
    isNearIntentsBridgeProviderEnabled: flag,
    isAcrossBridgeProviderEnabled: flag,
  })
  jest.mocked(useIsSmartContractWallet).mockReturnValue(true)
  const store = createStore()
  const view = render(
    <Provider store={store}>
      <BridgeProvidersUpdater />
    </Provider>,
  )
  expect([...store.get(bridgeProvidersAtom)]).toEqual([nearIntentsBridgeProvider])
  expect(relayBridgeProvider.quoteEnabled).toBe(false)

  jest.mocked(useIsSmartContractWallet).mockReturnValue(false)
  view.rerender(
    <Provider store={store}>
      <BridgeProvidersUpdater />
    </Provider>,
  )
  expect([...store.get(bridgeProvidersAtom)]).toEqual(
    expect.arrayContaining([acrossBridgeProvider, nearIntentsBridgeProvider, relayBridgeProvider]),
  )
  expect(relayBridgeProvider.quoteEnabled).toBe(true)
})

it('clears a cached empty Relay token result immediately when switching back to an EOA', async () => {
  jest.mocked(useFeatureFlags).mockReturnValue({})
  jest.mocked(useIsSmartContractWallet).mockReturnValue(true)
  const token = { chainId: 10, address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', decimals: 6, symbol: 'USDC' }
  const empty = { tokens: [], isRouteAvailable: false }
  jest.spyOn(acrossBridgeProvider, 'getBuyTokens').mockResolvedValue(empty)
  jest.spyOn(nearIntentsBridgeProvider, 'getBuyTokens').mockResolvedValue(empty)
  const relay = jest
    .spyOn(relayBridgeProvider, 'getBuyTokens')
    .mockImplementation(async () =>
      relayBridgeProvider.quoteEnabled ? { tokens: [token], isRouteAvailable: true } : empty,
    )
  const store = createStore()
  const view = render(
    <Provider store={store}>
      <BridgeProvidersUpdater />
    </Provider>,
  )
  const params = { buyChainId: 10, sellChainId: 8453 }
  expect(await bridgingSdk.getBuyTokens(params)).toEqual(empty)

  jest.mocked(useIsSmartContractWallet).mockReturnValue(false)
  view.rerender(
    <Provider store={store}>
      <BridgeProvidersUpdater />
    </Provider>,
  )
  expect(await bridgingSdk.getBuyTokens(params)).toEqual({ tokens: [token], isRouteAvailable: true })
  expect(relay).toHaveBeenCalledTimes(2)
})
