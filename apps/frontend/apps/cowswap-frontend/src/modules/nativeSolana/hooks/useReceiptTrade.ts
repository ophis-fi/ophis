import { useAtomValue, useStore } from 'jotai'
import { useEffect, useMemo, useState } from 'react'

import { historyAtom, pageSize } from '../state/history.atoms'

import type { SavedNativeSolanaOrder } from '../state/orders.atoms'
import type { OphisSolanaTrade } from '@ophis/solana-sdk'

export function useReceiptTrade(
  order: SavedNativeSolanaOrder,
  hasFill: boolean,
  indexed?: OphisSolanaTrade,
): {
  trade?: OphisSolanaTrade
  isFetchingTrade: boolean
  refreshTrade?: () => Promise<unknown>
  checkOlder?: () => void
} {
  const store = useStore()
  const [page, setPage] = useState(0)
  const lookup = hasFill && !indexed
  const history = useAtomValue(historyAtom(lookup ? page : -1))
  const trade = indexed ?? history.data?.find((row) => row.owner === order.owner && row.orderUid === order.uid)
  const { refetch } = history
  useEffect(() => {
    if (!lookup || trade || page !== 0 || order.reclaimed) return
    const timer = window.setInterval(() => void refetch({ cancelRefetch: false }), 4000)
    const end = window.setTimeout(() => window.clearInterval(timer), 60_000)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(end)
    }
  }, [lookup, trade, page, order.reclaimed, refetch])
  const hasOlder = !trade && history.data?.length === pageSize
  const refreshPage = trade ? page : 0
  return useMemo(
    () => ({
      trade,
      isFetchingTrade: history.isFetching,
      refreshTrade: lookup
        ? () => {
            setPage(refreshPage)
            return store.get(historyAtom(refreshPage)).refetch({ cancelRefetch: false })
          }
        : undefined,
      checkOlder: hasOlder ? () => setPage(page + 1) : undefined,
    }),
    [trade, history.isFetching, lookup, store, refreshPage, hasOlder, page],
  )
}
