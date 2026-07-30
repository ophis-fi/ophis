import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import { Badge, BadgeTone } from 'ophis/ds/Badge'

import { BasketLeg, BasketLegStatus, CANCELLABLE_LEG_STATUSES } from '../../types'

const STATUS_TONE: Record<BasketLegStatus, BadgeTone> = {
  pending: 'draft',
  signing: 'planned',
  open: 'beta',
  filled: 'live',
  cancelling: 'planned',
  cancelled: 'draft',
  expired: 'draft',
  failed: 'partner',
}

export interface BasketStatusProps {
  legs: readonly BasketLeg[]
  /** True while a placement is running. */
  isPlacing: boolean
  /** Manual one-click cancel of every still-open leg (mandatory scope). */
  onCancelUnfilled: () => void
}

/**
 * Per-leg status view for a basket. Lists each leg with a status pill and offers
 * the mandatory one-click "cancel unfilled legs" action. Because the legs are
 * independent CoW orders (Phase A is never atomic), each shows its own state:
 * some legs can fill while others are still open or already cancelled.
 */
export function BasketStatus({ legs, isPlacing, onCancelUnfilled }: BasketStatusProps): ReactNode {
  const cancellableCount = legs.filter((l) => CANCELLABLE_LEG_STATUSES.includes(l.status)).length

  return (
    <div>
      <p>
        <Trans>
          Basket of {legs.length} orders. Legs settle independently. This is not an atomic swap.
        </Trans>
      </p>
      <ul>
        {legs.map((leg) => (
          <li key={leg.leg}>
            <Badge tone={STATUS_TONE[leg.status]}>{leg.status}</Badge>{' '}
            <Trans>
              Leg {leg.leg}/{legs.length}
            </Trans>
            {leg.error ? `: ${leg.error}` : null}
          </li>
        ))}
      </ul>
      <button type="button" onClick={onCancelUnfilled} disabled={isPlacing || cancellableCount === 0}>
        <Trans>Cancel {cancellableCount} unfilled legs</Trans>
      </button>
    </div>
  )
}
