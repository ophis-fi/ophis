import { useEffect } from 'react'

import { getRpcProvider } from '@cowprotocol/common-const'
import { ChainInfo, OrderBookApi, setGlobalAdapter, SupportedChainId } from '@cowprotocol/cow-sdk'
import {
  AcrossBridgeProvider,
  BungeeBridgeProvider,
  BuyTokensParams,
  GetProviderBuyTokens,
  NearIntentsBridgeProvider,
} from '@cowprotocol/sdk-bridging'
import { EthersV5Adapter } from '@cowprotocol/sdk-ethers-v5-adapter'

import { useNetworkId } from '../state/network'

export const cowSdkAdapter = new EthersV5Adapter({
  provider: getRpcProvider(SupportedChainId.MAINNET)!,
})

export const orderBookApi = new OrderBookApi()

/**
 * Bungee, DECODE-ONLY (mirror of OphisBungeeBridgeProvider in cowswap-frontend's
 * tradingSdk/ophisBridgeProviders.ts; keep the two in sync). Its manual v1 API
 * has answered 410 Gone on every route since August 2026, so it stays
 * registered only so historical Bungee orders resolve by their appData-hook
 * dappId; it advertises no networks and no buy tokens, so nothing here calls
 * its API except status reads for those orders. useCrossChainTokens recovers
 * the destination token from the chain's token list instead.
 */
class DecodeOnlyBungeeBridgeProvider extends BungeeBridgeProvider {
  async getNetworks(): Promise<ChainInfo[]> {
    return []
  }

  async getBuyTokens(_params: BuyTokensParams): Promise<GetProviderBuyTokens> {
    return { tokens: [], isRouteAvailable: false }
  }
}

// `includeBridges` stays because BungeeApi.validateBridges throws at
// construction on other slugs.
const bungeeBridgeProvider = new DecodeOnlyBungeeBridgeProvider({
  apiOptions: { includeBridges: ['across', 'cctp', 'gnosis-native-bridge'] },
})

const acrossBridgeProvider = new AcrossBridgeProvider()

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
