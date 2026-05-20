import { atom } from 'jotai'

import { DefaultBridgeProvider } from '@cowprotocol/sdk-bridging'

import { acrossBridgeProvider, bungeeBridgeProvider, nearIntentsBridgeProvider } from 'tradingSdk/bridgingSdk'

// Ophis fork (Path A, 2026-05-20): enable all three providers by default.
// Upstream defaulted to bungee-only and gated NEAR/Across behind
// LaunchDarkly feature flags via BridgeProvidersUpdater. We don't run
// LaunchDarkly on our deployment — the Updater's early-return path
// (when flags are undefined) keeps whatever the atom defaults to. Adding
// all three here gives users EVM→Solana via NEAR Intents (CoW DAO's
// primary cross-chain provider per Nov 2025 announcement) PLUS Across
// for EVM↔EVM coverage Bungee misses.
export const bridgeProvidersAtom = atom(
  new Set<DefaultBridgeProvider>([bungeeBridgeProvider, acrossBridgeProvider, nearIntentsBridgeProvider]),
)

export const hasBridgeProvidersAtom = atom((get) => get(bridgeProvidersAtom).size > 0)
