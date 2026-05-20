import { bungeeAffiliateCode } from '@cowprotocol/common-const'
import { isBarn, isDev, isProd, isStaging } from '@cowprotocol/common-utils'
import {
  AcrossBridgeProvider,
  BridgingSdk,
  BungeeBridgeProvider,
  NearIntentsBridgeProvider,
} from '@cowprotocol/sdk-bridging'

import { orderBookApi } from 'cowSdk'

import { tradingSdk } from './tradingSdk'

const bungeeApiBase = getBungeeApiBase()

export const bungeeBridgeProvider = new BungeeBridgeProvider({
  apiOptions: {
    includeBridges: ['across', 'cctp', 'gnosis-native-bridge'],
    apiBaseUrl: bungeeApiBase ? `${bungeeApiBase}/api/v1/bungee` : undefined,
    manualApiBaseUrl: bungeeApiBase ? `${bungeeApiBase}/api/v1/bungee-manual` : undefined,
    affiliate: bungeeApiBase ? bungeeAffiliateCode : undefined,
  },
})

export const acrossBridgeProvider = new AcrossBridgeProvider()

export const nearIntentsBridgeProvider = new NearIntentsBridgeProvider({ apiKey: process.env.REACT_APP_NEAR_API_KEY })

export const bridgingSdk = new BridgingSdk({
  providers: [bungeeBridgeProvider, acrossBridgeProvider, nearIntentsBridgeProvider],
  enableLogging: !!localStorage.getItem('enableBridgingSdkLogs'),
  tradingSdk,
  orderBookApi,
})

// Ophis fork (Path A, 2026-05-20): enable all three bridge providers by
// default. Bungee + Across for EVM↔EVM, NEAR Intents for EVM↔Solana
// (and Bitcoin, plus all major EVM chains).
//
// Per cow-sdk v4.0.2 `NearIntentsBridgeProvider`:
// `NEAR_INTENTS_SUPPORTED_NETWORKS` includes: mainnet, optimism, base,
// arbitrumOne, polygon, avalanche, bnb, gnosisChain, plasma, bitcoin,
// solana. CoW DAO integrated NEAR Intents as their primary cross-chain
// provider in November 2025 per https://x.com/NEARProtocol/status/1995888195343425855
//
// Upstream cowswap gates Near + Across behind LaunchDarkly feature flags
// in `BridgeProvidersUpdater`. We don't run LaunchDarkly — the flags
// stay undefined → the updater's early-return preserves whatever's set
// here. To keep the contract simple, all three providers are advertised
// to the bridging SDK from boot.
bridgingSdk.setAvailableProviders([
  bungeeBridgeProvider.info.dappId,
  acrossBridgeProvider.info.dappId,
  nearIntentsBridgeProvider.info.dappId,
])

function getBungeeApiBase(): string | undefined {
  if (isProd || isDev || isStaging || isBarn) {
    return 'https://backend.bungee.exchange'
  }

  return 'https://bff.barn.cow.fi/proxies/socket'
}
