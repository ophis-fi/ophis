import { useMemo } from 'react'

import { getChainInfo, SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import type { ChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'

import useSWR, { SWRResponse } from 'swr'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'
import { toBridgeChainInfo } from 'tradingSdk/ophisBridgeChains'

import { useBridgeProvidersIds } from './useBridgeProvidersIds'

// SWR blocker (AGENTS.md, Data fetching & caching): this hook shares its
// provider-ids key scheme and refresh semantics with useBridgeSupportedTokens
// and useRoutesAvailability in this entity; migrating one of the three to
// atomWithQuery alone would split the bridge-provider cache between two
// systems. The change here is a one-line metadata lookup (getChainInfo), so the
// coordinated migration of all three hooks is left to its own change.
export function useBridgeSupportedNetworks(): SWRResponse<ChainInfo[]> {
  const providerIds = useBridgeProvidersIds()
  const key = providerIds.join('|')

  return useSWR(
    [key, 'useBridgeSupportedNetworks'],
    async () => {
      return bridgingSdk.getTargetNetworks()
    },
    SWR_NO_REFRESH_OPTIONS,
  )
}

/**
 * Metadata for ONE chain id: provider-advertised first, then the app's own
 * getChainInfo (CHAIN_INFO plus the bridge-only destinations). A chain no
 * enabled quote provider advertises (the decode-only
 * Bungee lists none; Across is off for smart-contract wallets; NEAR does not
 * list Unichain) still needs its label/logo to render a historical order's
 * receipt and progress, and getChainInfo knows every chain the app supports.
 * Availability for NEW quotes is decided from the full list above, not here.
 */
export function useBridgeSupportedNetwork(chainId: number | undefined): ChainInfo | undefined {
  const networks = useBridgeSupportedNetworks().data

  return useMemo(() => {
    if (!chainId) return undefined

    const advertised = networks?.find((chain) => chain.id === chainId)
    if (advertised) return advertised

    return getChainInfo(chainId as SupportedChainId) ? toBridgeChainInfo(chainId) : undefined
  }, [networks, chainId])
}
