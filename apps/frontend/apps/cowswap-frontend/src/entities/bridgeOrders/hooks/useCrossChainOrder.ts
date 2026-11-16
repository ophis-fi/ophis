import { useAtomValue } from 'jotai'
import { useEffect, useMemo } from 'react'

import { isRelayRecoveryRequired } from '@cowprotocol/common-const'
import { COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS } from '@cowprotocol/common-utils'
import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { CrossChainOrder, BridgeStatus } from '@cowprotocol/sdk-bridging'

import { atomWithQuery, queryClientAtom, type AtomWithQueryResult } from 'jotai-tanstack-query'
import ms from 'ms.macro'
import { bridgingSdk } from 'tradingSdk/bridgingSdk'

const UPDATE_INTERVAL = ms`5s`

export const BRIDGING_FINAL_STATUSES = [BridgeStatus.EXECUTED, BridgeStatus.EXPIRED, BridgeStatus.REFUND]

export function useCrossChainOrder(
  chainId: SupportedChainId | undefined,
  orderUid: string | undefined,
): AtomWithQueryResult<CrossChainOrder | null, Error> {
  const queryClient = useAtomValue(queryClientAtom)
  // Mount Jotai's client so requests paused offline resume when connectivity returns.
  useEffect(() => {
    queryClient.mount()
    return () => queryClient.unmount()
  }, [queryClient])
  const queryAtom = useMemo(
    () =>
      atomWithQuery<CrossChainOrder | null, Error>(() => ({
        queryKey: [chainId, orderUid, 'useCrossChainOrder'],
        enabled: !!chainId && !!orderUid,
        queryFn: () =>
          chainId && orderUid
            ? bridgingSdk.getOrder({
                chainId,
                orderId: orderUid,
                settlementContractOverride: COW_PROTOCOL_SETTLEMENT_CONTRACT_ADDRESS,
              })
            : null,
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
    [chainId, orderUid],
  )
  return useAtomValue(queryAtom)
}
