import { useMemo } from 'react'

import { CHAIN_INFO } from '@cowprotocol/common-const'
import { useAvailableTargetChains, useFeatureFlags } from '@cowprotocol/common-hooks'
import { AdditionalTargetChainId, ChainInfo, TargetChainId } from '@cowprotocol/cow-sdk'

import { mapChainInfo } from '../utils/mapChainInfo'

/**
 * The destination chains gated behind a bridge feature flag.
 *
 * This must NOT be `isAdditionalTargetChain()`: AdditionalTargetChainId holds
 * OPTIMISM (10) alongside BITCOIN and SOLANA, because upstream CoW does not
 * TRADE on Optimism and models it as a bridge-target-only chain. Gating on the
 * enum therefore dropped Optimism from every destination list no matter what the
 * flags said, so Optimism could not be selected as a bridge destination from any
 * source chain — even though Across and NEAR Intents both deliver there, it sits
 * in SORTED_DST_CHAIN_IDS, it has a CHAIN_INFO entry, and filterDestinationChains
 * admits it. Only the two non-EVM chains are actually flag-gated.
 *
 * (Ophis additionally runs its own sovereign settlement on Optimism, so "cannot
 * bridge into OP" was a gap on one of our own chains.)
 */
const FLAG_GATED_TARGET_CHAINS: ReadonlySet<TargetChainId> = new Set([
  AdditionalTargetChainId.BITCOIN,
  AdditionalTargetChainId.SOLANA,
])

// Type predicate (not a plain boolean) so callers keep the narrowing the previous
// isAdditionalTargetChain() guard gave them: the set holds only
// AdditionalTargetChainId members, so a match proves the narrower type.
export function isFlagGatedTargetChain(id: TargetChainId): id is AdditionalTargetChainId {
  return FLAG_GATED_TARGET_CHAINS.has(id)
}

/**
 * Returns the list of supported destination (buy-side) chains as ChainInfo[].
 * Includes non-EVM chains (BTC, Solana) when their bridge feature flags are enabled.
 */
export function useSupportedTargetChains(): ChainInfo[] {
  const availableTargetChains = useAvailableTargetChains()
  const { isBtcBridgeEnabled, isSolBridgeEnabled } = useFeatureFlags()

  const additionalChains = useMemo(() => {
    const set = new Set<AdditionalTargetChainId>()
    if (isBtcBridgeEnabled) set.add(AdditionalTargetChainId.BITCOIN)
    if (isSolBridgeEnabled) set.add(AdditionalTargetChainId.SOLANA)
    return set
  }, [isBtcBridgeEnabled, isSolBridgeEnabled])

  return useMemo(() => {
    return availableTargetChains.reduce((acc, id) => {
      if (isFlagGatedTargetChain(id) && !additionalChains.has(id)) {
        return acc
      }

      const info = CHAIN_INFO[id]
      if (info) acc.push(mapChainInfo(id, info))
      return acc
    }, [] as ChainInfo[])
  }, [availableTargetChains, additionalChains])
}
