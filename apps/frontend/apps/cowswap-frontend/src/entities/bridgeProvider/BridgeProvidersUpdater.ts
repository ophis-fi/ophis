import { useSetAtom } from 'jotai'
import { useEffect } from 'react'

import { RELAY_ENABLED } from '@cowprotocol/common-const'
import { useFeatureFlags } from '@cowprotocol/common-hooks'
import { DefaultBridgeProvider } from '@cowprotocol/sdk-bridging'
import { useIsSmartContractWallet } from '@cowprotocol/wallet'

import {
  acrossBridgeProvider,
  nearIntentsBridgeProvider,
  relayBridgeProvider,
  setQuoteBridgeProviders,
} from 'tradingSdk/bridgingSdk'

import { bridgeProvidersAtom } from './bridgeProvidersAtom'

function toggleProvider(providers: Set<DefaultBridgeProvider>, provider: DefaultBridgeProvider, flag: boolean): void {
  if (flag) {
    providers.add(provider)
  } else {
    providers.delete(provider)
  }
}

export function BridgeProvidersUpdater(): null {
  const setBridgeProviders = useSetAtom(bridgeProvidersAtom)
  const { isNearIntentsBridgeProviderEnabled, isAcrossBridgeProviderEnabled } = useFeatureFlags()
  const isSmartContractWallet = useIsSmartContractWallet()

  useEffect(() => {
    setBridgeProviders((providers) => {
      const newProviders = new Set(providers)

      toggleProvider(newProviders, nearIntentsBridgeProvider, isNearIntentsBridgeProviderEnabled !== false)

      // Only Near intents provider should be available for smart-contract wallets
      if (isSmartContractWallet) {
        toggleProvider(newProviders, acrossBridgeProvider, false)
      } else {
        toggleProvider(newProviders, acrossBridgeProvider, isAcrossBridgeProviderEnabled !== false)
      }
      toggleProvider(newProviders, relayBridgeProvider, RELAY_ENABLED && !isSmartContractWallet)

      // Through the one writer that keeps the decode-only registry entries
      // (historical Bungee orders) resolvable whatever is enabled for quoting.
      setQuoteBridgeProviders([...newProviders].map((p) => p.info.dappId))

      return newProviders
    })
  }, [isNearIntentsBridgeProviderEnabled, isAcrossBridgeProviderEnabled, isSmartContractWallet, setBridgeProviders])

  return null
}
