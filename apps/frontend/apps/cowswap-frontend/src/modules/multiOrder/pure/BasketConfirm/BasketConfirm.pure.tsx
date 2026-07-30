import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import { Badge } from 'ophis/ds/Badge'

import { allLegsQuoted, canConfirmBasket } from '../basketReady'
import { BasketDraft, BasketTier } from '../../types'

export interface BasketConfirmProps {
  draft: BasketDraft
  /** Whether the connected wallet can batch-presign (smart-account tier available). */
  batchAvailable: boolean
  isPlacing: boolean
  onConfirm: () => void
  onCancel: () => void
}

const TIER_LABEL: Record<BasketTier, ReactNode> = {
  stepped: <Trans>one signature per leg</Trans>,
  batch: <Trans>one batched signature</Trans>,
}

/**
 * One-screen review of a composed basket before placement: every leg with its
 * sell and (quoted) buy amount, the shared deadline, and the signing tier. Makes
 * the non-atomic nature explicit: legs are placed as independent CoW orders,
 * best-effort together, and any that do not fill can be cancelled in one click.
 */
export function BasketConfirm({ draft, batchAvailable, isPlacing, onConfirm, onCancel }: BasketConfirmProps): ReactNode {
  // Only allow placement once EVERY leg has a validated quote (a defined min-buy).
  // Starting the sequential loop while any quote is still loading or failed would
  // sign legs with no min-out and expose a partial basket.
  const quotesReady = allLegsQuoted(draft.legs)
  const canConfirm = canConfirmBasket(draft, isPlacing)
  return (
    <div>
      <h3>
        <Trans>Review your basket</Trans> <Badge tone="beta">{draft.legs.length} legs</Badge>
      </h3>

      <p>
        <Trans>
          Ophis places these as {draft.legs.length} independent orders sharing one deadline. They are
          submitted best-effort together, but they are not atomic: some legs may fill while others do
          not. Unfilled legs can be cancelled in one click.
        </Trans>
      </p>

      <table>
        <thead>
          <tr>
            <th>
              <Trans>Leg</Trans>
            </th>
            <th>
              <Trans>Sell</Trans>
            </th>
            <th>
              <Trans>Buy (min)</Trans>
            </th>
          </tr>
        </thead>
        <tbody>
          {draft.legs.map((leg) => (
            <tr key={leg.leg}>
              <td>{leg.leg}</td>
              <td>
                {leg.sellAmount.toString()} {leg.sellToken}
              </td>
              <td>
                {leg.buyAmount ?? '...'} {leg.buyToken}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        <Trans>Signing: {TIER_LABEL[draft.tier]}.</Trans>{' '}
        {batchAvailable ? (
          <Badge tone="live">
            <Trans>batch available</Trans>
          </Badge>
        ) : null}
      </p>

      {!quotesReady ? (
        <p>
          <Trans>Waiting for every leg to be quoted before you can place the basket.</Trans>
        </p>
      ) : null}

      <button type="button" onClick={onConfirm} disabled={!canConfirm}>
        <Trans>Place basket</Trans>
      </button>
      <button type="button" onClick={onCancel} disabled={isPlacing}>
        <Trans>Back</Trans>
      </button>
    </div>
  )
}
