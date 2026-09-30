import { useAtom, useAtomValue } from 'jotai'
import { ReactNode, useCallback, useState } from 'react'

import { nearTokensAtom, nearTransfersAtom } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import { getNearFundingDeadline, nearErrorMessage } from './nearDirect.service'
import { Panel, Stack } from './nearDirect.styled'
import { NearQuote } from './NearQuote.pure'
import { NearSwapForm } from './NearSwapForm.container'
import { NearTransferCard } from './NearTransferCard.container'

export function NearDirectSwap({ recoveryOnly = false }: { recoveryOnly?: boolean }): ReactNode {
  const { data: tokens = [], isPending, error: tokenError, refetch } = useAtomValue(nearTokensAtom)
  const [transfers, setTransfers] = useAtom(nearTransfersAtom)
  const [preview, setPreview] = useState<NearTransfer>()
  const [error, setError] = useState('')
  const confirm = useCallback(async (): Promise<void> => {
    if (!preview || recoveryOnly) return
    try {
      if (getNearFundingDeadline(preview.response) <= Date.now() + 60_000)
        throw new Error('Quote expired. Go back and review a new quote.')
      await setTransfers((current) =>
        current.some((item) => item.response.signature === preview.response.signature)
          ? current
          : [...current, preview],
      )
      setPreview(undefined)
      setError('')
    } catch (failure) {
      setError(nearErrorMessage(failure))
    }
  }, [preview, recoveryOnly, setTransfers])
  return (
    <Stack>
      {recoveryOnly && transfers.length > 0 && (
        <p>New NEAR swaps are paused. Existing swaps are still tracked below.</p>
      )}
      {!recoveryOnly && (
        <Panel aria-label="Cross-chain swap via NEAR Intents">
          <h2>Cross-chain swap</h2>
          <p>Send from your wallet and receive on another network through NEAR Intents.</p>
          {preview && (
            <>
              <NearQuote transfer={preview} />
              <button type="button" onClick={confirm}>
                Confirm and show deposit instructions
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreview(undefined)
                  setError('')
                }}
              >
                Back
              </button>
            </>
          )}
          <NearSwapForm tokens={tokens} isPending={isPending} hidden={!!preview} onQuote={setPreview} />
          {(error || tokenError) && <p role="alert">{error || 'Unable to load NEAR assets. Please try again.'}</p>}
          {tokenError && (
            <button type="button" onClick={() => refetch()}>
              Retry loading assets
            </button>
          )}
        </Panel>
      )}
      {transfers
        .slice()
        .reverse()
        .map((transfer) => (
          <NearTransferCard key={transfer.response.signature} transfer={transfer} allowFunding={!recoveryOnly} />
        ))}
    </Stack>
  )
}
