import { useAtomValue } from 'jotai'
import { useEffect, useMemo } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'

import * as Sentry from '@sentry/react'
import { orderBookApi } from 'cowSdk'
import { atomWithQuery, queryClientAtom } from 'jotai-tanstack-query'

const OPHIS_SUPPORTED_CHAINS: ReadonlyArray<number> = [10 /* Optimism mainnet */, 4663 /* Robinhood Chain mainnet */]
const COW_ORDER_UID_LENGTH = 114 // "0x" + 56 bytes hex

async function fetchSettlementTxHash(chainId: number, orderUid: string): Promise<string | null> {
  try {
    const trades = await orderBookApi.getTrades({ orderUid }, { chainId: chainId as SupportedChainId })
    // Trades are chronological; the latest non-null hash identifies the settlement.
    for (let i = trades.length - 1; i >= 0; i--) {
      const tx = trades[i]?.txHash
      if (tx) return tx
    }
    return null
  } catch (error) {
    // Keep the address-page fallback, with a breadcrumb for diagnosing orderbook failures.
    console.warn('[useSettlementTxHash] orderbook getTrades failed', { chainId, orderUid, error })
    Sentry.addBreadcrumb({
      category: 'ophis.settlement',
      level: 'warning',
      message: 'useSettlementTxHash: orderbook getTrades failed',
      data: { chainId, orderUid, errorMessage: error instanceof Error ? error.message : String(error) },
    })
    return null
  }
}

/** Returns null while pending or unavailable so callers retain their address-page fallback. */
export function useSettlementTxHash(chainId: number | undefined, orderUid: string | undefined): string | null {
  const queryClient = useAtomValue(queryClientAtom)
  // Mount Jotai's client so requests paused offline resume when connectivity returns.
  useEffect(() => {
    queryClient.mount()
    return () => queryClient.unmount()
  }, [queryClient])
  const queryAtom = useMemo(() => {
    const enabled =
      !!chainId && OPHIS_SUPPORTED_CHAINS.includes(chainId) && !!orderUid && orderUid.length === COW_ORDER_UID_LENGTH
    return atomWithQuery<string | null, Error>(() => ({
      queryKey: ['ophis-settlement-tx', chainId, orderUid],
      enabled,
      queryFn: () => (enabled && chainId && orderUid ? fetchSettlementTxHash(chainId, orderUid) : null),
      staleTime: 2000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchIntervalInBackground: false,
      retry: false,
      // Settlement is final; poll only while the hash is missing.
      refetchInterval: ({ state: { data } }) => (data ? false : 8000),
    }))
  }, [chainId, orderUid])

  return useAtomValue(queryAtom).data ?? null
}
