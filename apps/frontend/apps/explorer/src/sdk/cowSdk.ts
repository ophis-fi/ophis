import { useEffect } from 'react'

import {
  acrossV5History,
  createDecodeOnlyBungeeBridgeProvider,
  getAcrossV5BuyTokens,
  getAcrossV5Status,
  getRpcProvider,
  ophisAcrossApiOptions,
  registerOphisNearIntentsNetworks,
  RelayBridgeProvider,
} from '@cowprotocol/common-const'
import { setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import { AcrossBridgeProvider, NearIntentsBridgeProvider } from '@cowprotocol/sdk-bridging'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'

import { orderBookSDK } from '../cowSdk'
import { useNetworkId } from '../state/network'

export const cowSdkAdapter = new EthersV5Adapter({
  provider: getRpcProvider(SupportedChainId.MAINNET)!,
})

export const orderBookApi = orderBookSDK

// Same NEAR destination registration as the swap app, so historical orders to
// Monad / X Layer resolve their network and tokens here too.
registerOphisNearIntentsNetworks()

// Bungee, DECODE-ONLY (shared class in common-const, also used by the swap
// app): registered only so historical Bungee orders resolve by their
// appData-hook dappId; it advertises no networks and no buy tokens, so nothing
// here calls its API except status reads for those orders. useCrossChainTokens
// recovers the destination token from the chain's token list instead.
export const bungeeBridgeProvider = createDecodeOnlyBungeeBridgeProvider()

class ExplorerAcrossProvider extends AcrossBridgeProvider {
  getBridgingParams(
    ...args: Parameters<AcrossBridgeProvider['getBridgingParams']>
  ): ReturnType<AcrossBridgeProvider['getBridgingParams']> {
    return acrossV5History(super.getBridgingParams.bind(this), ...args)
  }

  getBuyTokens(
    params: Parameters<AcrossBridgeProvider['getBuyTokens']>[0],
  ): ReturnType<AcrossBridgeProvider['getBuyTokens']> {
    return getAcrossV5BuyTokens(params)
  }

  getStatus(...args: Parameters<AcrossBridgeProvider['getStatus']>): ReturnType<AcrossBridgeProvider['getStatus']> {
    return /^\d+$/.test(args[0]) ? super.getStatus(...args) : getAcrossV5Status(args[0])
  }
}

const acrossBridgeProvider = new ExplorerAcrossProvider({ apiOptions: ophisAcrossApiOptions() })

const nearIntentsBridgeProvider = new NearIntentsBridgeProvider({ apiKey: process.env.REACT_APP_NEAR_API_KEY })

const relayBridgeProvider = new RelayBridgeProvider({ enabled: false, apiUrl: 'https://swap.ophis.fi/api/relay' })
export const knownBridgeProviders = [
  bungeeBridgeProvider,
  acrossBridgeProvider,
  nearIntentsBridgeProvider,
  relayBridgeProvider,
]

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
