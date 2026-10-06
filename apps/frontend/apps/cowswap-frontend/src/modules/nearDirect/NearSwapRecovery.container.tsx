import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useRef, useState } from 'react'

import { ButtonSecondary } from '@cowprotocol/ui'

import { nearTokensAtom, nearTransfersAtom } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import { NearSwapActivity } from './NearSwapActivity.container'
import * as styledEl from './NearSwapActivity.styled'

export function NearSwapRecovery({ allowFunding }: { allowFunding: boolean }): ReactNode {
  const transfers = useAtomValue(nearTransfersAtom)
  if (!transfers.length) return null
  return <RecoveryTransfers transfers={transfers} allowFunding={allowFunding} />
}

function RecoveryTransfers({
  transfers,
  allowFunding,
}: {
  transfers: NearTransfer[]
  allowFunding: boolean
}): ReactNode {
  const { error: tokenError, refetch } = useAtomValue(nearTokensAtom)
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [showHistory, setShowHistory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const historyButton = useRef<HTMLButtonElement>(null)
  const visible = transfers.filter((transfer) => !transfer.archived)
  const archivedCount = transfers.length - visible.length
  const archive = async (signatures: string[], archived: boolean): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await setTransfers((current) =>
        current.map((item) => (signatures.includes(item.response.signature) ? { ...item, archived } : item)),
      )
      historyButton.current?.focus()
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to update swap history. Please retry.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <styledEl.Activity aria-label="Swap activity">
      <header>
        <h3>{showHistory ? 'Swap history' : 'Swap activity'}</h3>
        <styledEl.Actions>
          {!showHistory && visible.length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                archive(
                  visible.map((item) => item.response.signature),
                  true,
                )
              }
            >
              Clear from page
            </button>
          )}
          <button type="button" ref={historyButton} onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? 'Back to activity' : `History (${archivedCount})`}
          </button>
        </styledEl.Actions>
      </header>
      {error && <p role="alert">{error}</p>}
      {showHistory && <p>Cleared swaps stay recoverable here. Clearing does not cancel a swap.</p>}
      {!showHistory && !visible.length && <p role="status">Page cleared. Your swaps are saved in History.</p>}
      {showHistory && !archivedCount && <p>No cleared swaps.</p>}
      {tokenError && (visible.length > 0 || showHistory) && (
        <>
          <p role="alert">Unable to verify swap assets. Please try again.</p>
          <ButtonSecondary onClick={() => refetch()}>Retry loading assets</ButtonSecondary>
        </>
      )}
      {!allowFunding && visible.length > 0 && (
        <p>New cross-chain swaps are paused. Existing swaps are still tracked below.</p>
      )}
      {transfers
        .slice()
        .reverse()
        .map((transfer, index) => (
          <NearSwapActivity
            key={transfer.response.signature}
            transfer={transfer}
            allowFunding={allowFunding}
            hidden={!!transfer.archived !== showHistory}
            initiallyOpen={index === 0 && transfer.status === 'PENDING_DEPOSIT' && !transfer.archived}
            busy={busy}
            onArchive={(signature, archived) => void archive([signature], archived)}
          />
        ))}
    </styledEl.Activity>
  )
}
