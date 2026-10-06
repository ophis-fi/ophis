import { useAtomValue } from 'jotai'
import { ReactNode, useState } from 'react'

import { ChevronDown, RotateCcw, X } from 'lucide-react'

import { nearTransferStatusAtom } from './nearDirect.atoms'
import { DIRECT_NEAR_CHAINS } from './nearDirect.constants'
import { NearTransfer } from './nearDirect.schemas'
import { withLatestNearStatus } from './nearDirect.service'
import * as styledEl from './NearSwapActivity.styled'
import { NearTransferCard } from './NearTransferCard.container'

const LABELS = {
  PENDING_DEPOSIT: 'Awaiting deposit',
  KNOWN_DEPOSIT_TX: 'Confirming deposit',
  INCOMPLETE_DEPOSIT: 'Awaiting refund',
  PROCESSING: 'In progress',
  SUCCESS: 'Completed',
  REFUNDED: 'Refunded',
  FAILED: 'Needs attention',
}

export function NearSwapActivity({
  transfer,
  allowFunding,
  hidden,
  initiallyOpen,
  busy,
  onArchive,
}: {
  transfer: NearTransfer
  allowFunding: boolean
  hidden: boolean
  initiallyOpen: boolean
  busy: boolean
  onArchive(signature: string, archived: boolean): void
}): ReactNode {
  const [expanded, setExpanded] = useState(initiallyOpen)
  const { data, error } = useAtomValue(nearTransferStatusAtom(transfer.response.signature))
  const latest = withLatestNearStatus(transfer, data)
  const pair = `${transfer.source.symbol} → ${transfer.destination.symbol}`
  const label =
    latest.status === 'PENDING_DEPOSIT' && (transfer.fundingStarted || transfer.transactionHash)
      ? 'Checking deposit'
      : LABELS[latest.status]
  return (
    <styledEl.Row hidden={hidden}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <span>
            <strong>{pair}</strong>
            <small>
              {DIRECT_NEAR_CHAINS[transfer.source.blockchain]?.label} →{' '}
              {DIRECT_NEAR_CHAINS[transfer.destination.blockchain]?.label}
            </small>
            <small>
              <span aria-live="polite">{error ? 'Tracking unavailable' : label}</span>
              {' · '}
              <time dateTime={transfer.response.timestamp}>
                {new Date(transfer.response.timestamp).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            </small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </summary>
        {/* Keep recovery mounted while collapsed or archived so polling and
            durable status updates continue without exposing funding controls. */}
        <NearTransferCard transfer={transfer} allowFunding={allowFunding} />
      </details>
      <button
        type="button"
        disabled={busy}
        aria-label={transfer.archived ? `Restore ${pair} to activity` : `Clear ${pair} from page`}
        title={transfer.archived ? 'Restore to activity' : 'Clear from page'}
        onClick={() => onArchive(transfer.response.signature, !transfer.archived)}
      >
        {transfer.archived ? <RotateCcw size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
      </button>
    </styledEl.Row>
  )
}
