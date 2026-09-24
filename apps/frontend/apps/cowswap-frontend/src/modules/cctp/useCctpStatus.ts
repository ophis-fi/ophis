import { useEffect, useMemo, useState } from 'react'

import { useIsOnline, useIsWindowVisible } from '@cowprotocol/common-hooks'

import { type CctpTransfer } from './cctp.service'
import { getCctpStatus, type CctpStatus } from './cctpStatus.service'

export function useCctpStatus(transfer: CctpTransfer | null): { status: CctpStatus | null; error: string | null } {
  const [result, setResult] = useState<{ transfer: CctpTransfer; status: CctpStatus } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = useIsWindowVisible()
  const online = useIsOnline()
  useEffect(() => {
    setResult(null)
    setError(null)
    if (!transfer || !visible || !online) return undefined
    let cancelled = false
    let sourceVerified = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const next = await getCctpStatus(transfer, sourceVerified)
        sourceVerified = next.sourceConfirmed
        if (cancelled) return
        setResult({ transfer, status: next })
        setError(null)
        if (next.completed || next.failed || !transfer.burnHash) return
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not refresh bridge status')
      }
      if (!cancelled) timer = setTimeout(refresh, 15_000)
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [transfer, visible, online])
  return useMemo(
    () => ({ status: result?.transfer === transfer ? result.status : null, error }),
    [result, transfer, error],
  )
}
