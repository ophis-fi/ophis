import { useAtomValue } from 'jotai'
import { useEffect, useState } from 'react'

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
  const [page, setPage] = useState(0)
  const lookup = hasFill && !indexed
  const history = useAtomValue(historyAtom(lookup ? page : -1))
  const trade = indexed ?? history.data?.find((row) => row.owner === order.owner && row.orderUid === order.uid)
  const { refetch } = history
  useEffect(() => {
    if (!lookup || trade || page !== 0 || order.reclaimed) return
    const timer = window.setInterval(() => void refetch(), 4000)
    const end = window.setTimeout(() => window.clearInterval(timer), 60_000)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(end)
    }
  }, [lookup, trade, page, order.reclaimed, refetch])
  return {
    trade,
    isFetchingTrade: history.isFetching,
    refreshTrade: lookup ? refetch : undefined,
    checkOlder: !trade && history.data?.length === pageSize ? () => setPage(page + 1) : undefined,
  }
}
