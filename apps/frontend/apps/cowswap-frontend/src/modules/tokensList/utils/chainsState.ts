import { BRIDGE_SOURCE_CHAIN_IDS } from '@cowprotocol/common-const'
import { isSupportedChainId } from '@cowprotocol/common-utils'
import { AdditionalTargetChainId, ChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'

import { sortChainsByDisplayOrder } from './sortChainsByDisplayOrder'

import { ChainsToSelectState } from '../types'

export interface CreateOutputChainsOptions {
  selectedTargetChainId: SupportedChainId | number
  chainId: SupportedChainId
  currentChainInfo: ChainInfo
  bridgeSupportedNetworks: ChainInfo[] | undefined
  supportedChains: ChainInfo[]
  isLoading: boolean
  routesAvailability: {
    unavailableChainIds: Set<number>
    loadingChainIds: Set<number>
    isLoading: boolean
  }
  additionalChainIds?: Set<number>
}

export function computeDisabledChainIds(
  orderedChains: ChainInfo[],
  chainId: SupportedChainId,
  destinationIds: Set<number>,
  sourceSupported: boolean,
  isLoading: boolean,
): Set<number> {
  if (isLoading) return new Set()

  return new Set(
    orderedChains
      .filter((chain) => {
        if (chain.id === chainId) return false
        if (!sourceSupported) return true
        return !destinationIds.has(chain.id)
      })
      .map((c) => c.id),
  )
}

export function createInputChainsState(
  selectedTargetChainId: SupportedChainId | number,
  supportedChains: ChainInfo[],
): ChainsToSelectState {
  return {
    defaultChainId: selectedTargetChainId,
    chains: sortChainsByDisplayOrder(supportedChains),
    isLoading: false,
  }
}

export function createOutputChainsState({
  selectedTargetChainId,
  chainId,
  currentChainInfo,
  bridgeSupportedNetworks,
  supportedChains,
  isLoading,
  routesAvailability,
}: CreateOutputChainsOptions): ChainsToSelectState {
  const chainSet = new Set(supportedChains.map((c) => c.id))
  const chainsWithCurrent = chainSet.has(chainId) ? supportedChains : [...supportedChains, currentChainInfo]
  const orderedChains = sortChainsByDisplayOrder(chainsWithCurrent)

  const destinationIds = new Set(filterDestinationChains(bridgeSupportedNetworks)?.map((c) => c.id) ?? [])
  // Source capability is NOT the destination list: destinations only need the
  // provider API to deliver there, while sources need on-chain execution
  // machinery (see BRIDGE_SOURCE_CHAIN_IDS). Gating on destinationIds here
  // would offer bridging FROM destination-only chains (Unichain, Robinhood
  // Chain, Ink, Linea) where every quote fails.
  const sourceSupported = BRIDGE_SOURCE_CHAIN_IDS.has(chainId)

  const baseDisabledChainIds = computeDisabledChainIds(
    orderedChains,
    chainId,
    destinationIds,
    sourceSupported,
    isLoading,
  )

  const disabledChainIds = new Set([...baseDisabledChainIds, ...routesAvailability.unavailableChainIds])

  const resolvedDefaultChainId = resolveDefaultChainId(orderedChains, selectedTargetChainId, chainId, disabledChainIds)

  return {
    defaultChainId: resolvedDefaultChainId,
    chains: orderedChains,
    isLoading,
    disabledChainIds: disabledChainIds.size > 0 ? disabledChainIds : undefined,
    loadingChainIds: routesAvailability.loadingChainIds.size > 0 ? routesAvailability.loadingChainIds : undefined,
  }
}

export function filterDestinationChains(bridgeSupportedNetworks: ChainInfo[] | undefined): ChainInfo[] | undefined {
  // isSupportedChainId admits the Ophis chains missing from the SDK enums
  // (Unichain 130, Robinhood Chain 4663) so the widened provider network lists
  // survive this filter; unknown chains a provider might list are still dropped.
  return bridgeSupportedNetworks?.filter(
    (chain) => chain.id in SupportedChainId || chain.id in AdditionalTargetChainId || isSupportedChainId(chain.id),
  )
}

export function resolveDefaultChainId(
  orderedChains: ChainInfo[],
  selectedTargetChainId: number,
  chainId: SupportedChainId,
  disabledChainIds: Set<number>,
): number {
  const isSelectedTargetValid =
    orderedChains.some((c) => c.id === selectedTargetChainId) && !disabledChainIds.has(selectedTargetChainId)
  if (isSelectedTargetValid) return selectedTargetChainId

  const sourceInList = orderedChains.some((c) => c.id === chainId)
  if (sourceInList) return chainId

  const firstEnabledChain = orderedChains.find((c) => !disabledChainIds.has(c.id))
  return firstEnabledChain?.id ?? orderedChains[0]?.id ?? chainId
}
