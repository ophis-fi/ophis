import { atom } from 'jotai'

import { DefaultBridgeProvider } from '@cowprotocol/sdk-bridging'

import { acrossBridgeProvider, nearIntentsBridgeProvider } from 'tradingSdk/bridgingSdk'

// The providers enabled for QUOTING. Ophis fork (Path A, 2026-05-20): both on
// by default. Upstream defaulted to bungee-only and gated NEAR/Across behind
// LaunchDarkly feature flags via BridgeProvidersUpdater. We don't run
// LaunchDarkly on our deployment — the Updater's early-return path (when flags
// are undefined) keeps whatever the atom defaults to. NEAR Intents gives
// EVM→Solana/Bitcoin plus nine EVM chains; Across is the only route into
// Unichain, Robinhood Chain, Ink and Linea. Bungee is not a quote provider any
// more (its API is permanently 410); its decode-only registration lives in
// tradingSdk/bridgingSdk (setQuoteBridgeProviders), not here.
export const bridgeProvidersAtom = atom(
  new Set<DefaultBridgeProvider>([acrossBridgeProvider, nearIntentsBridgeProvider]),
)

export const hasBridgeProvidersAtom = atom((get) => get(bridgeProvidersAtom).size > 0)
