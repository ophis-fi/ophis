import { useAtomValue, useSetAtom } from 'jotai'
import { ReactNode, useCallback, useEffect, useState } from 'react'

import { useCopyClipboard, useInterval } from '@cowprotocol/common-hooks'

import { QRCode } from 'react-qrcode-logo'

import { nearTokensAtom, nearTransfersAtom, nearTransferStatusAtom } from './nearDirect.atoms'
import { NearTransfer } from './nearDirect.schemas'
import {
  getNearFundingDeadline,
  hasCurrentNearAssets,
  isExpiredUnfundedNearTransfer,
  nearErrorMessage,
  submitNearDeposit,
  withLatestNearStatus,
} from './nearDirect.service'
import { Panel } from './nearDirect.styled'
import { NearQuote } from './NearQuote.pure'
import { NearWalletSend } from './NearWalletSend.container'

const STATUS_LABELS = {
  PENDING_DEPOSIT: 'Waiting for your deposit',
  KNOWN_DEPOSIT_TX: 'Deposit detected; waiting for confirmations',
  INCOMPLETE_DEPOSIT: 'Deposit is below the required amount; waiting for refund processing',
  PROCESSING: 'Swap processing',
  SUCCESS: 'Delivered',
  REFUNDED: 'Refunded to your refund address',
  FAILED: 'Swap failed; check the provider for refund status',
}

export function NearTransferCard({
  transfer,
  allowFunding = true,
}: {
  transfer: NearTransfer
  allowFunding?: boolean
}): ReactNode {
  const setTransfers = useSetAtom(nearTransfersAtom)
  const { data: tokens = [] } = useAtomValue(nearTokensAtom)
  const { data, error: statusError } = useAtomValue(nearTransferStatusAtom(transfer.response.signature))
  const [now, setNow] = useState(() => Date.now())
  const [error, setError] = useState('')
  useInterval(() => setNow(Date.now()), 10_000)
  useEffect(() => {
    if (data && data.statusUpdatedAt !== transfer.statusUpdatedAt) {
      void setTransfers((current) => current.map((item) => withLatestNearStatus(item, data))).catch(
        (failure: unknown) => setError(failure instanceof Error ? failure.message : 'Unable to save status.'),
      )
    }
  }, [data, transfer.statusUpdatedAt, setTransfers])
  const deadline = getNearFundingDeadline(transfer.response)
  const latest = withLatestNearStatus(transfer, data)
  const canFund =
    latest.status === 'PENDING_DEPOSIT' && now < deadline && !transfer.fundingStarted && !transfer.transactionHash
  const assetsVerified = hasCurrentNearAssets(transfer, tokens)

  const removeExpired = useCallback(async (): Promise<void> => {
    if (!window.confirm('Remove this expired quote? Only continue if you checked your wallet and sent no deposit.'))
      return
    try {
      await setTransfers((current) =>
        current.filter(
          (item) => item.response.signature !== transfer.response.signature || !isExpiredUnfundedNearTransfer(item),
        ),
      )
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Unable to remove this quote.')
    }
  }, [transfer.response.signature, setTransfers])

  return (
    <Panel aria-label="Swap tracking">
      <h3 aria-live="polite">{STATUS_LABELS[latest.status]}</h3>
      <NearQuote transfer={latest} />
      {!assetsVerified && allowFunding && <p>Verifying assets before displaying deposit instructions…</p>}
      {assetsVerified && allowFunding && (
        <NearFundingInstructions transfer={latest} canFund={canFund} deadline={deadline} />
      )}
      {latest.status === 'PENDING_DEPOSIT' && transfer.fundingError && (
        <p role="alert">
          {transfer.transactionHash && transfer.fundingError === 'Internal Server Error'
            ? 'A transaction hash was saved. Do not send again; check your wallet and retry tracking below.'
            : transfer.fundingError}
        </p>
      )}
      {transfer.transactionHash && (
        <p>
          Source transaction: <code>{transfer.transactionHash}</code>
        </p>
      )}
      {!['SUCCESS', 'REFUNDED'].includes(latest.status) && <NearDepositTracking transfer={latest} />}
      {isExpiredUnfundedNearTransfer(latest, now) && (
        <button type="button" onClick={removeExpired}>
          Remove expired quote
        </button>
      )}
      {(error || statusError) && (
        <p role="alert">
          {error || 'Status is temporarily unavailable. Do not send a second deposit; tracking will retry.'}
        </p>
      )}
      <small>Swap reference: {transfer.response.correlationId}</small>
    </Panel>
  )
}

function NearDepositTracking({ transfer }: { transfer: NearTransfer }): ReactNode {
  const setTransfers = useSetAtom(nearTransfersAtom)
  const [txHash, setTxHash] = useState<string>()
  const depositTxHash = (txHash ?? transfer.transactionHash ?? '').trim()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await submitNearDeposit(transfer, depositTxHash, () =>
        setTransfers((current) =>
          current.map((item) =>
            item.response.signature === transfer.response.signature
              ? { ...item, fundingStarted: true, transactionHash: depositTxHash }
              : item,
          ),
        ),
      )
    } catch (failure) {
      setError(nearErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }, [busy, transfer, depositTxHash, setTransfers])

  return (
    <>
      <label>
        Already sent? Add the source transaction hash (optional)
        <input value={txHash ?? transfer.transactionHash ?? ''} onChange={(event) => setTxHash(event.target.value)} />
      </label>
      <button type="button" disabled={busy || !depositTxHash} onClick={submit}>
        Track transaction
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  )
}

function NearFundingInstructions({
  transfer,
  canFund,
  deadline,
}: {
  transfer: NearTransfer
  canFund: boolean
  deadline: number
}): ReactNode {
  const [copied, copy] = useCopyClipboard()
  const { depositAddress, depositMemo } = transfer.response.quote
  if (transfer.status !== 'PENDING_DEPOSIT') return null
  if (!canFund || !depositAddress)
    return (
      <p>
        {transfer.fundingStarted || transfer.transactionHash
          ? 'A deposit may already have been sent. Check your wallet before taking any further action.'
          : 'Deposit instructions have expired. Do not send funds to this quote.'}
      </p>
    )
  return (
    <>
      <p>Send the exact amount shown above once. Keep enough funds for your wallet’s network fee.</p>
      <label>
        Deposit address
        <input readOnly value={depositAddress} />
      </label>
      <button type="button" onClick={() => copy(depositAddress)}>
        {copied ? 'Copied' : 'Copy deposit address'}
      </button>
      {depositMemo ? (
        <p>
          Required memo: <code>{depositMemo}</code>. Include it with the transfer.
        </p>
      ) : (
        <QRCode value={depositAddress} size={150} />
      )}
      <small>Deposit deadline: {new Date(deadline).toLocaleString()}. Allow time for network confirmations.</small>
      <NearWalletSend transfer={transfer} />
    </>
  )
}
