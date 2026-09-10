import { useMemo } from 'react'

import { CHAIN_INFO, SWR_NO_REFRESH_OPTIONS } from '@cowprotocol/common-const'
import type { ChainInfo, SupportedChainId } from '@cowprotocol/cow-sdk'

import useSWR, { SWRResponse } from 'swr'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'
import { toBridgeChainInfo } from 'tradingSdk/ophisBridgeChains'

import { useBridgeProvidersIds } from './useBridgeProvidersIds'

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
 * CHAIN_INFO. A chain no enabled quote provider advertises (the decode-only
 * Bungee lists none; Across is off for smart-contract wallets; NEAR does not
 * list Unichain) still needs its label/logo to render a historical order's
 * receipt and progress, and CHAIN_INFO knows every chain the app supports.
 * Availability for NEW quotes is decided from the full list above, not here.
 */
export function useBridgeSupportedNetwork(chainId: number | undefined): ChainInfo | undefined {
  const networks = useBridgeSupportedNetworks().data

  return useMemo(() => {
    if (!chainId) return undefined

    const advertised = networks?.find((chain) => chain.id === chainId)
    if (advertised) return advertised

    return CHAIN_INFO[chainId as SupportedChainId] ? toBridgeChainInfo(chainId) : undefined
  }, [networks, chainId])
}
