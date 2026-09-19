import { useAtomValue } from 'jotai'
import { useMemo } from 'react'

import { isInjectedWidget } from '@cowprotocol/common-utils'

import { atomWithQuery } from 'jotai-tanstack-query'

import { getTradeRewardCampaign } from '../lib/ophisAffiliateApi'

export function useTradeRewardPromotion(chainId: number): boolean {
  const enabled = !isInjectedWidget()
  const campaignAtom = useMemo(
    () =>
      atomWithQuery(() => ({
        queryKey: ['tradeRewardCampaign'],
        queryFn: getTradeRewardCampaign,
        enabled,
        retry: false,
        gcTime: 0,
        refetchInterval: 30_000,
        refetchOnWindowFocus: true,
      })),
    [enabled],
  )
  const query = useAtomValue(campaignAtom)
  return (
    enabled && !query.error && query.data?.campaignAvailable === true && query.data.eligibleChainIds.includes(chainId)
  )
}
