import { useEffect } from 'react'

import {
  createDecodeOnlyBungeeBridgeProvider,
  getRpcProvider,
  ophisAcrossApiOptions,
  registerOphisNearIntentsNetworks,
} from '@cowprotocol/common-const'
import { OrderBookApi, setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, NearIntentsBridgeProvider } from '@cowprotocol/sdk-bridging'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'

import { useNetworkId } from '../state/network'

export const cowSdkAdapter = new EthersV5Adapter({
  provider: getRpcProvider(SupportedChainId.MAINNET)!,
})

export const orderBookApi = new OrderBookApi()

// Same NEAR destination registration as the swap app, so historical orders to
// Monad / X Layer resolve their network and tokens here too.
registerOphisNearIntentsNetworks()

// Bungee, DECODE-ONLY (shared class in common-const, also used by the swap
// app): registered only so historical Bungee orders resolve by their
// appData-hook dappId; it advertises no networks and no buy tokens, so nothing
// here calls its API except status reads for those orders. useCrossChainTokens
// recovers the destination token from the chain's token list instead.
export const bungeeBridgeProvider = createDecodeOnlyBungeeBridgeProvider()

const acrossBridgeProvider = new AcrossBridgeProvider({ apiOptions: ophisAcrossApiOptions() })

const nearIntentsBridgeProvider = new NearIntentsBridgeProvider({ apiKey: process.env.REACT_APP_NEAR_API_KEY })

export const knownBridgeProviders = [bungeeBridgeProvider, acrossBridgeProvider, nearIntentsBridgeProvider]

setGlobalAdapter(cowSdkAdapter)

export function CowSdkUpdater(): null {
  const chainId = useNetworkId()

  useEffect(() => {
    if (!chainId) return

    const provider = getRpcProvider(chainId)
    if (provider) {
      cowSdkAdapter.setProvider(provider)
      cowSdkAdapter.setSigner(provider.getSigner())
    }
  }, [chainId])

  return null
}
