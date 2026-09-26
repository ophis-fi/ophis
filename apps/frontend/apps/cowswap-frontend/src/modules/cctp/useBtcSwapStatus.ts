import { useEffect, useMemo, useState } from 'react'

import { useIsOnline, useIsWindowVisible } from '@cowprotocol/common-hooks'

import { type BtcSwapPending } from './btcSwapState'
import { getBtcSwapStatus } from './btcSwapStatus.service'

export function useBtcSwapStatus(pending: BtcSwapPending | null): {
  status: Awaited<ReturnType<typeof getBtcSwapStatus>> | null
  error: string | null
} {
  const [result, setResult] = useState<{
    pending: BtcSwapPending
    status: Awaited<ReturnType<typeof getBtcSwapStatus>>
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = useIsWindowVisible()
  const online = useIsOnline()
  useEffect(() => {
    setError(null)
    if (!pending || !visible || !online) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const status = await getBtcSwapStatus(pending)
        if (cancelled) return
        setResult({ pending, status })
        setError(null)
        if (status.amount || status.ended) return
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : 'Could not check swap status')
      }
      if (!cancelled) timer = setTimeout(refresh, 15_000)
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [pending, visible, online])
  return useMemo(
    () => ({ status: result?.pending === pending ? result.status : null, error }),
    [result, pending, error],
  )
}
