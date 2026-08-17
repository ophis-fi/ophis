import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { MAX_BASKET_BUY_TOKENS, MAX_BASKET_LEGS, MAX_BASKET_SELL_TOKENS } from 'ophis/basketMetadata'
import { Badge } from 'ophis/ds/Badge'

import { DecomposedLeg } from '../decomposition'

export interface BasketWidgetProps {
  sellCount: number
  buyCount: number
  /** Live decomposition preview (null while incomplete / over a cap). */
  legs: DecomposedLeg[] | null
  /** Decomposition error to surface (e.g. over the leg cap), if any. */
  error: string | null
  onAddSell: () => void
  onAddBuy: () => void
  onReview: () => void
}

/**
 * Compose-a-basket entry widget: N sell tokens x M buy tokens on one screen
 * (owner decision 39: up to 6 x 6, decomposed into at most 6 single-pair legs).
 * Presentational shell: the token/amount rows are supplied by the container's
 * existing selectors; this component owns the counts, the live leg preview, the
 * cap messaging, and the "Review" gate.
 */
export function BasketWidget({
  sellCount,
  buyCount,
  legs,
  error,
  onAddSell,
  onAddBuy,
  onReview,
}: BasketWidgetProps): ReactNode {
  const legCount = legs?.length ?? 0
  const canReview = !error && legCount >= 1

  return (
    <div>
      <h3>
        <Trans>Compose a basket</Trans> <Badge tone="beta">Beta</Badge>
      </h3>
      <p>
        <Trans>
          Swap several tokens at once. Ophis splits your basket into up to {MAX_BASKET_LEGS} single-pair orders that
          share one deadline. Best-effort together, not atomic.
        </Trans>
      </p>

      <div>
        <button type="button" onClick={onAddSell} disabled={sellCount >= MAX_BASKET_SELL_TOKENS}>
          <Trans>
            Add sell token ({sellCount}/{MAX_BASKET_SELL_TOKENS})
          </Trans>
        </button>
        <button type="button" onClick={onAddBuy} disabled={buyCount >= MAX_BASKET_BUY_TOKENS}>
          <Trans>
            Add buy token ({buyCount}/{MAX_BASKET_BUY_TOKENS})
          </Trans>
        </button>
      </div>

      {error ? (
        <p role="alert">{error}</p>
      ) : legs ? (
        <p>
          <Trans>{legCount} legs</Trans>
        </p>
      ) : null}

      <button type="button" onClick={onReview} disabled={!canReview}>
        <Trans>Review basket</Trans>
      </button>
    </div>
  )
}
