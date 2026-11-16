import { useAtomValue } from 'jotai'
import { useEffect, useMemo } from 'react'

import { isRelayRecoveryRequired } from '@cowprotocol/common-const'
import { CowEnv } from '@cowprotocol/cow-sdk'
import { CrossChainOrder, getCrossChainOrder, BridgeStatus } from '@cowprotocol/sdk-bridging'

import { atomWithQuery, queryClientAtom, type AtomWithQueryResult } from 'jotai-tanstack-query'
import ms from 'ms.macro'
import { orderBookApi, knownBridgeProviders } from 'sdk/cowSdk'

import { useNetworkId } from '../../../state/network'

const UPDATE_INTERVAL = ms`15s`

export const BRIDGING_FINAL_STATUSES = [BridgeStatus.EXECUTED, BridgeStatus.EXPIRED, BridgeStatus.REFUND]

export function useCrossChainOrder(orderId: string | undefined): AtomWithQueryResult<CrossChainOrder | null, Error> {
  const chainId = useNetworkId()
  const queryClient = useAtomValue(queryClientAtom)
  // Mount Jotai's client so requests paused offline resume when connectivity returns.
  useEffect(() => {
    queryClient.mount()
    return () => queryClient.unmount()
  }, [queryClient])
  const queryAtom = useMemo(
    () =>
      atomWithQuery<CrossChainOrder | null, Error>(() => ({
        queryKey: ['useCrossChainOrder', orderId, chainId],
        enabled: !!orderId && !!chainId,
        queryFn: async () => {
          if (!orderId || !chainId) return null
          const getOrder = (env: CowEnv): ReturnType<typeof getCrossChainOrder> =>
            getCrossChainOrder({ chainId, orderId, env, providers: knownBridgeProviders, orderBookApi })
          return (await getOrder('prod').catch(() => getOrder('staging'))) ?? null
        },
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        refetchIntervalInBackground: false,
        retry: false,
        refetchInterval: ({ state: { data } }) =>
          data &&
          (BRIDGING_FINAL_STATUSES.includes(data.statusResult.status) || isRelayRecoveryRequired(data.statusResult))
            ? false
            : UPDATE_INTERVAL,
      })),
    [chainId, orderId],
  )
  return useAtomValue(queryAtom)
}
