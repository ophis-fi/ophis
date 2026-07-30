import { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'

import { Badge } from 'ophis/ds/Badge'

export interface BasketBadgeProps {
  /** This leg's 1-based index within its basket. */
  leg: number
  /** Total legs in the basket. */
  legs: number
}

/**
 * Orders-table grouping badge for a basket leg: a small "Basket 2/6" pill that
 * marks a leg as part of an Ophis basket (owner decision 40: the public name is
 * "Basket", shared with Phase B). Rendered next to a leg's status so a user
 * scanning their orders sees which ones were placed together, even though the
 * legs are independent CoW orders (never advertised as atomic in Phase A).
 */
export function BasketBadge({ leg, legs }: BasketBadgeProps): ReactNode {
  return (
    <Badge tone="beta">
      <Trans>
        Basket {leg}/{legs}
      </Trans>
    </Badge>
  )
}
