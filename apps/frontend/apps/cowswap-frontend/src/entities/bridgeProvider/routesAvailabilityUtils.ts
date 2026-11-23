import { SupportedChainId } from '@cowprotocol/cow-sdk'

import { bridgingSdk } from 'tradingSdk/bridgingSdk'

export interface RoutesAvailabilityResult {
  unavailableChainIds: Set<number>
  loadingChainIds: Set<number>
  isLoading: boolean
}

export interface RouteCheckResult {
  chainId: number
  isAvailable: boolean
}

export const EMPTY_ROUTES_RESULT: RoutesAvailabilityResult = {
  unavailableChainIds: new Set(),
  loadingChainIds: new Set(),
  isLoading: false,
}

export function filterDestinationChains(destinationChainIds: number[], sourceChainId: number | undefined): number[] {
  return destinationChainIds.filter((id) => id !== sourceChainId)
}

export type RoutesAvailabilityKey = [SupportedChainId, string, string, string]

export async function fetchRoutesAvailability(key: RoutesAvailabilityKey): Promise<RouteCheckResult[]> {
  const [sellChainId, chainIdsString] = key
  const chainIds = chainIdsString.split(',').map(Number)

  return Promise.all(chainIds.map((buyChainId) => checkSingleRouteAvailability(sellChainId, buyChainId)))
}

async function checkSingleRouteAvailability(
  sellChainId: SupportedChainId,
  buyChainId: number,
): Promise<RouteCheckResult> {
  try {
    const result = await bridgingSdk.getBuyTokens({ sellChainId, buyChainId })
    const isAvailable = result.tokens.length > 0 && result.isRouteAvailable

    return { chainId: buyChainId, isAvailable }
  } catch (error) {
    console.warn(`[routesAvailability] Failed to check route ${sellChainId} -> ${buyChainId}`, error)

    return { chainId: buyChainId, isAvailable: false }
  }
}

export interface BuildResultParams {
  queryKey: RoutesAvailabilityKey | null
  isLoading: boolean
  data: RouteCheckResult[] | undefined
  chainsToCheck: number[]
}

export function buildRoutesAvailabilityResult(params: BuildResultParams): RoutesAvailabilityResult {
  const { queryKey, isLoading, data, chainsToCheck } = params

  if (!queryKey) {
    return EMPTY_ROUTES_RESULT
  }

  if (isLoading || !data) {
    return {
      unavailableChainIds: new Set(),
      loadingChainIds: new Set(chainsToCheck),
      isLoading: true,
    }
  }

  const unavailableChainIds = new Set<number>(
    data.filter((result) => !result.isAvailable).map((result) => result.chainId),
  )

  return {
    unavailableChainIds,
    loadingChainIds: new Set(),
    isLoading: false,
  }
}
