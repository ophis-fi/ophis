import { useSetAtom } from 'jotai'
import { ReactNode, useState } from 'react'

import { SupportedChainId } from '@cowprotocol/cow-sdk'
import { ButtonPrimary, ButtonSecondary } from '@cowprotocol/ui'

import { AddressInputPanel } from 'common/pure/AddressInputPanel'

import { useNearSwapAddresses } from './hooks/useNearSwapAddresses'
import { nearTransfersAtom } from './nearDirect.atoms'
import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearToken, NearTransfer } from './nearDirect.schemas'
import { getNearFundingDeadline, nearErrorMessage, requestNearQuote } from './nearDirect.service'
import { Stack } from './nearDirect.styled'
import { NearQuote } from './NearQuote.pure'
import { StarknetWallet } from './StarknetWallet.container'

interface NearSwapDetailsProps {
  source: NearToken | undefined
  destination: NearToken | undefined
  amount: string
  recipient: string
  refundTo: string
  setRefundTo(value: string): void
  preview: NearTransfer | undefined
  setPreview(value: NearTransfer | undefined): void
  busy: boolean
  setBusy(value: boolean): void
  isPending: boolean
  tokenError: boolean
  refetch(): unknown
}

export function NearSwapDetails(props: NearSwapDetailsProps): ReactNode {
  const {
    source,
    destination,
    amount,
    recipient,
    refundTo,
    setRefundTo,
    preview,
    setPreview,
    busy,
    setBusy,
    isPending,
    tokenError,
    refetch,
  } = props
  const resolved = useNearSwapAddresses(source, destination, refundTo, recipient)
  const ready = [source, destination, amount, resolved.recipient, resolved.refundTo].every(Boolean)
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [error, setError] = useState('')
  const review = async (): Promise<void> => {
    if (busy || !ready || !source || !destination) return
    setBusy(true)
    setError('')
    try {
      setPreview(await requestNearQuote(source, destination, amount, resolved.recipient, resolved.refundTo))
    } catch (failure) {
      setError(nearErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }
  const confirm = async (): Promise<void> => {
    if (!preview || busy) return
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }
  return (
    <Stack>
      {preview ? (
        <>
          <NearQuote transfer={preview} />
          <ButtonPrimary disabled={busy} onClick={confirm}>
            Confirm swap
          </ButtonPrimary>
          <ButtonSecondary
            disabled={busy}
            onClick={() => {
              setPreview(undefined)
              setError('')
            }}
          >
            Back
          </ButtonSecondary>
        </>
      ) : (
        <>
          <StarknetWallet source={source} onConnect={setRefundTo} disabled={busy} />
          <AddressInputPanel
            id="refund-address"
            label="Refund address on the sending network"
            value={refundTo}
            onChange={(value) => {
              if (!busy) setRefundTo(value)
            }}
            targetChainId={source ? (DIRECT_NEAR_CHAINS[source.blockchain]?.id as SupportedChainId) : undefined}
          />
          {(source?.blockchain === 'zec' || destination?.blockchain === 'zec') && (
            <small>
              Use a Zcash mainnet transparent t1/t3 address. Shielded and unified addresses are not supported.
            </small>
          )}
          {(source?.blockchain === 'hypercore' || destination?.blockchain === 'hypercore') && (
            <small>Use your Hypercore spot balance. HyperEVM is a separate network.</small>
          )}
          <ButtonPrimary disabled={busy || isPending || !ready} onClick={review}>
            {busy ? 'Getting quote…' : isPending ? 'Loading assets…' : 'Review swap'}
          </ButtonPrimary>
        </>
      )}
      {(error || tokenError) && <p role="alert">{error || 'Unable to load assets. Please try again.'}</p>}
      {tokenError && <ButtonSecondary onClick={() => refetch()}>Retry loading assets</ButtonSecondary>}
    </Stack>
  )
}
