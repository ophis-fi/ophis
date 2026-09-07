import type { ReactNode } from 'react'

import { LinkStyledButton } from '@cowprotocol/ui'

import { Callout } from 'ophis/ds'

export function OtcOrderReadError({ retryOrder }: { retryOrder(): void }): ReactNode {
  return (
    <div role="alert" aria-live="assertive" aria-atomic="true">
      <Callout tone="warning" title="Verified order unavailable">
        <p>The verified order read failed. Check your connection, then retry this order.</p>
        <LinkStyledButton type="button" onClick={retryOrder}>
          Retry order
        </LinkStyledButton>
      </Callout>
    </div>
  )
}
