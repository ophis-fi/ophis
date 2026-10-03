import { useAtom } from 'jotai'
import { ReactNode, useEffect, useState } from 'react'

import * as styledEl from './AcrossDirect.styled'
import {
  acrossFinished,
  acrossPendingAtom,
  acrossPendingSchema,
  acrossStatus,
  updateAcrossPending,
} from './acrossState.service'

export function AcrossRecovery(): ReactNode {
  const [stored, persist] = useAtom(acrossPendingAtom)
  const [hash, setHash] = useState('')
  const [status, setStatus] = useState('Checking Across transfer…')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const parsed = acrossPendingSchema.safeParse(stored)
  useEffect(() => {
    setStatus('Checking Across transfer…')
    setError('')
    if (!stored) return undefined
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const refresh = async (): Promise<void> => {
      try {
        const next = await acrossStatus(acrossPendingSchema.parse(stored))
        if (cancelled) return
        setStatus(next)
        setError('')
        if (acrossFinished(next)) return
      } catch {
        if (!cancelled) setError('Waiting for transfer confirmation. Your saved transfer is still being tracked.')
      }
      if (!cancelled) timer = setTimeout(refresh, 10_000)
    }
    void refresh()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [stored])
  if (!stored) return null
  if (!parsed.success)
    return <p role="alert">Saved Across transfer data is invalid. Keep your source transaction hash for recovery.</p>
  const pending = parsed.data
  const update = async (sourceHash?: string): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await updateAcrossPending(pending, persist, sourceHash)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not update this transfer.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <styledEl.Card aria-label="Across transfer">
      <strong role="status">{status}</strong>
      {pending.hash ? (
        <a href={`https://explorer.arc.io/tx/${pending.hash}`} target="_blank" rel="noopener noreferrer">
          View deposit on Arc
        </a>
      ) : (
        <>
          <label htmlFor="across-recovery-hash">Source transaction hash</label>
          <input id="across-recovery-hash" value={hash} onChange={(event) => setHash(event.target.value)} />
          <button type="button" disabled={busy || !hash} onClick={() => update(hash)}>
            Track transfer
          </button>
        </>
      )}
      {acrossFinished(status) && (
        <button type="button" disabled={busy} onClick={() => update()}>
          Close
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </styledEl.Card>
  )
}
