import { BridgingSdk } from '@cowprotocol/sdk-bridging'

import { orderBookApi } from 'cowSdk'

import { OphisAcrossBridgeProvider, OphisBungeeBridgeProvider } from './ophisBridgeProviders'
import { OphisNearIntentsBridgeProvider } from './ophisNearIntentsProvider.service'
import { tradingSdk } from './tradingSdk'

// Bungee is registered DECODE-ONLY (see OphisBungeeBridgeProvider): it never
// quotes and never receives token-picker traffic, it only lets the SDK resolve
// historical Bungee orders by their appData hook dappId. Hence no API base,
// dedicated-proxy routing or affiliate header any more; `includeBridges` stays
// because BungeeApi.validateBridges throws at construction on other slugs.
export const bungeeBridgeProvider = new OphisBungeeBridgeProvider({
  apiOptions: { includeBridges: ['across', 'cctp', 'gnosis-native-bridge'] },
})

export const acrossBridgeProvider = new OphisAcrossBridgeProvider()

// `|| undefined`: an unset GitHub secret renders as '' in the deploy env, and
// an empty-string apiKey would make the SDK send a blank Bearer header instead
// of falling back to keyless mode (which works, but carries NEAR's
// unauthenticated platform appFee — set REACT_APP_NEAR_API_KEY to remove it).
// The Ophis subclass fixes the attestation hash the pinned SDK gets wrong AND
// adds referral attribution + the 3 bps integrator appFee (see its header).
export const nearIntentsBridgeProvider = new OphisNearIntentsBridgeProvider({
  apiKey: process.env.REACT_APP_NEAR_API_KEY || undefined,
})

// Bungee LAST: the SDK's single-provider getQuote path takes providers[0] for
// a cross-chain request without checking getNetworks, and getAvailableProviders
// preserves this constructor order, so the decode-only entry must never be first.
export const bridgingSdk = new BridgingSdk({
  providers: [acrossBridgeProvider, nearIntentsBridgeProvider, bungeeBridgeProvider],
  enableLogging: !!localStorage.getItem('enableBridgingSdkLogs'),
  tradingSdk,
  orderBookApi,
})

/**
 * Provider ids the SDK must ALWAYS be able to resolve, whatever set is enabled
 * for quoting. getProviderFromAppData and getOrder search the SDK's available
 * list, so a historical Bungee order needs Bungee in it even when
 * BridgeProvidersUpdater narrows the quote providers (smart-contract wallets,
 * feature flags). Being available costs nothing: the provider advertises no
 * networks and no buy tokens, so no quote or token-list request reaches it.
 */
const DECODE_ONLY_PROVIDER_IDS: readonly string[] = [bungeeBridgeProvider.info.dappId]

/**
 * The one writer of the SDK's available list: the providers enabled for quoting
 * plus the decode-only registry entries. Every runtime update must go through
 * here so the decode entries can never be dropped.
 */
export function setQuoteBridgeProviders(quoteProviderIds: readonly string[]): void {
  bridgingSdk.setAvailableProviders([...new Set([...quoteProviderIds, ...DECODE_ONLY_PROVIDER_IDS])])
}

// Ophis fork (Path A, 2026-05-20): the live providers are Across for EVM<->EVM
// (the only route into Unichain, Robinhood Chain, Ink and Linea) and NEAR
// Intents for EVM<->Solana/Bitcoin plus the nine EVM chains it lists.
//
// Upstream cowswap gates Near + Across behind LaunchDarkly feature flags
// in `BridgeProvidersUpdater`. We don't run LaunchDarkly — the flags
// stay undefined → the updater's early-return preserves whatever's set
// here. To keep the contract simple, both quote providers are advertised
// to the bridging SDK from boot.
setQuoteBridgeProviders([acrossBridgeProvider.info.dappId, nearIntentsBridgeProvider.info.dappId])
