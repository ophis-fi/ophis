import { FormEvent, ReactNode, useCallback, useState } from 'react'

import { NearAssetSelect } from './NearAssetSelect.pure'
import { NearToken, NearTransfer } from './nearDirect.schemas'
import { nearErrorMessage, requestNearQuote } from './nearDirect.service'

interface NearSwapFormProps {
  tokens: NearToken[]
  isPending: boolean
  hidden: boolean
  onQuote(quote: NearTransfer): void
}
export function NearSwapForm({ tokens, isPending, hidden, onQuote }: NearSwapFormProps): ReactNode {
  const [sourceId, setSource] = useState('')
  const [destinationId, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [recipient, setRecipient] = useState('')
  const [refundTo, setRefundTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const source = tokens.find((token) => token.assetId === sourceId)
  const destination = tokens.find((token) => token.assetId === destinationId)

  const review = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (busy || !source || !destination) return
      setBusy(true)
      setError('')
      try {
        onQuote(await requestNearQuote(source, destination, amount, recipient.trim(), refundTo.trim()))
      } catch (failure) {
        setError(nearErrorMessage(failure))
      } finally {
        setBusy(false)
      }
    },
    [busy, source, destination, amount, recipient, refundTo, onQuote],
  )

  return (
    <form hidden={hidden} onSubmit={review}>
      <fieldset disabled={busy || isPending}>
        <NearAssetSelect
          label="Send asset and network"
          tokens={tokens}
          value={sourceId}
          onChange={(value) => {
            setSource(value)
            setRefundTo('')
          }}
        />
        <label>
          Amount
          <input required inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
        </label>
        <NearAssetSelect
          label="Receive asset and network"
          tokens={tokens}
          value={destinationId}
          onChange={(value) => {
            setDestination(value)
            setRecipient('')
          }}
        />
        <label>
          Receiving wallet address
          <input
            required
            autoComplete="off"
            spellCheck={false}
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
        <label>
          Refund address on the sending network
          <input
            required
            autoComplete="off"
            spellCheck={false}
            value={refundTo}
            onChange={(event) => setRefundTo(event.target.value)}
          />
        </label>
        {(source?.blockchain === 'zec' || destination?.blockchain === 'zec') && (
          <small>
            Zcash requires a mainnet transparent t1/t3 address. Shielded and unified addresses are not supported by this
            route.
          </small>
        )}
        {(source?.blockchain === 'hypercore' || destination?.blockchain === 'hypercore') && (
          <small>Use the Hypercore spot balance. HyperEVM is a separate network.</small>
        )}
        <button type="submit" disabled={!source || !destination}>
          {busy ? 'Getting quote…' : isPending ? 'Loading assets…' : 'Review swap'}
        </button>
        {error && <p role="alert">{error}</p>}
      </fieldset>
    </form>
  )
}
