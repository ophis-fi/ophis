import { useFlags } from 'launchdarkly-react-client-sdk'

export interface FeatureFlags {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any
}

/**
 * Ophis fork (2026-05-20): we don't run LaunchDarkly on ophis.fi, so
 * `useFlags()` returns an empty object and every consumer sees
 * `undefined`. Upstream already left a `defaults` slot for this case
 * (commented out). This config enables the features we ship — the
 * pre-deploy audit (sharp-edges 2026-05-20 H1/H2) caught that without
 * these defaults:
 *
 *  - `BridgeProvidersUpdater` early-returns forever → SC-wallet
 *    branch never fires → Safe users get all three providers including
 *    Across which has SC-wallet attestation issues. Setting the three
 *    provider flags to TRUE makes the updater run normally and the
 *    SC-wallet enforcement at BridgeProvidersUpdater.ts:47 kicks in.
 *  - `useAvailableTargetChains` filters out BTC + Solana when the
 *    isBtc/isSolBridgeEnabled flags are falsy. Setting both to TRUE
 *    surfaces the Solana destination in the chain selector — which
 *    is the whole point of enabling NearIntentsBridgeProvider.
 *
 * LD-supplied flags still override these defaults via spread order:
 * `{ ...defaults, ...flags }`. So if we ever wire up LD with explicit
 * values (e.g. to A/B-test a provider), the LD value wins.
 */
const defaults: Partial<FeatureFlags> = {
  // Bridge providers — enable all three so users see EVM↔Solana via
  // NEAR Intents AND EVM↔EVM via Bungee/Across.
  isBungeeBridgeProviderEnabled: true,
  isAcrossBridgeProviderEnabled: true,
  isNearIntentsBridgeProviderEnabled: true,
  // Destination chains — surface Bitcoin + Solana in the target-chain
  // picker (gated by isBtcBridgeEnabled / isSolBridgeEnabled in
  // useAvailableTargetChains + useSupportedTargetChains).
  isBtcBridgeEnabled: true,
  isSolBridgeEnabled: true,
}

export function useFeatureFlags(): FeatureFlags {
  const flags = useFlags<FeatureFlags>()
  return { ...defaults, ...flags }
}
