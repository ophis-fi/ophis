import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { useIsBridgingEnabled } from '@cowprotocol/common-hooks'
import { SupportedChainId, TargetChainId } from '@cowprotocol/cow-sdk'

import { hasWalletBridgeRoute, useIsCctpEnabled } from 'entities/cctp'
import { atomWithQuery } from 'jotai-tanstack-query'

import {
  buildRoutesAvailabilityResult,
  fetchRoutesAvailability,
  filterDestinationChains,
  RoutesAvailabilityKey,
  RoutesAvailabilityResult,
} from './routesAvailabilityUtils'
import { useBridgeProvidersIds } from './useBridgeProvidersIds'

export type { RoutesAvailabilityResult } from './routesAvailabilityUtils'

/**
 * Pre-checks route availability for multiple destination chains from a source chain.
 * Returns which chains have unavailable routes and which are still loading.
 */
export function useRoutesAvailability(
  sourceChainId: SupportedChainId | undefined,
  destinationChainIds: TargetChainId[],
): RoutesAvailabilityResult {
  const isBridgingEnabled = useIsBridgingEnabled()
  const cctpEnabled = useIsCctpEnabled()
  const providerIds = useBridgeProvidersIds()
  const providersKey = providerIds.join('|')

  const chainsToCheck = useMemo(
    () =>
      filterDestinationChains(destinationChainIds, sourceChainId).filter(
        (id) => !cctpEnabled || !sourceChainId || !hasWalletBridgeRoute(sourceChainId, id),
      ),
    [destinationChainIds, sourceChainId, cctpEnabled],
  )

  const destinations = chainsToCheck
    .slice()
    .sort((a, b) => a - b)
    .join(',')
  const queryKey = useMemo<RoutesAvailabilityKey | null>(
    () =>
      isBridgingEnabled && sourceChainId && destinations
        ? [sourceChainId, destinations, providersKey, 'routesAvailability']
        : null,
    [isBridgingEnabled, sourceChainId, destinations, providersKey],
  )
  const queryAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: queryKey ?? ['routesAvailability', 'disabled'],
        enabled: !!queryKey,
        queryFn: () => (queryKey ? fetchRoutesAvailability(queryKey) : []),
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      })),
    [queryKey],
  )
  const { data, isLoading } = useAtomValue(queryAtom)

  return useMemo(
    () => buildRoutesAvailabilityResult({ queryKey, isLoading, data, chainsToCheck }),
    [queryKey, isLoading, data, chainsToCheck],
  )
}
