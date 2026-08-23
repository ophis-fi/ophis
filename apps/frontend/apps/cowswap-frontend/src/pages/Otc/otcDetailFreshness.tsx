import type { ReactNode } from 'react'

import { Trans } from '@lingui/react/macro'
import { Callout } from 'ophis/ds'

import type { OtcNodeFreshness } from './otcDetailFreshness.utils'

interface OtcFreshnessNoticeProps {
  freshness: OtcNodeFreshness
  loading: boolean
  failed: boolean
}

export function OtcFreshnessNotice({ freshness, loading, failed }: OtcFreshnessNoticeProps): ReactNode {
  if (freshness === 'stale') {
    return (
      <Callout tone="warning" title={<Trans>Network data may be outdated</Trans>}>
        <p>
          <Trans>
            The backend that served this order appears to be behind the network. The order state below was verified
            on-chain but may not reflect the latest blocks.
          </Trans>
        </p>
      </Callout>
    )
  }
  if (freshness === 'unknown' && !loading && !failed) {
    return (
      <Callout tone="warning" title={<Trans>Freshness could not be assessed</Trans>}>
        <p>
          <Trans>
            The independent freshness comparison is unavailable right now. The order below passed direct on-chain
            verification at the shown block, but it may not reflect the latest network state.
          </Trans>
        </p>
      </Callout>
    )
  }
  return null
}
