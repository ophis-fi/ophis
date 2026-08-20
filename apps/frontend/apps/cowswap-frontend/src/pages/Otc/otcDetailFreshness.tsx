import type { ReactNode } from 'react'

import { Callout } from 'ophis/ds'

import type { OtcDataState } from 'ophis/otc'

export type OtcNodeFreshness = 'fresh' | 'stale' | 'unknown'

/**
 * Freshness verdict for the DETAIL page. A load-balanced public RPC can route
 * the list snapshot and the direct order read to backends at different
 * heights, so when both the index checkpoint and the detail read's own block
 * are known, the verdict compares THOSE two — the list hook's verdict only
 * fills in when the direct comparison is impossible. Indeterminate states are
 * 'unknown', never silently fresh.
 */
export function assessDetailFreshness(
  state: OtcDataState,
  detailBlockNumber: bigint | null,
  maxIndexLagBlocks: bigint,
): OtcNodeFreshness {
  const indexedBlock = state.enrichment?.indexedBlock ?? null
  if (indexedBlock !== null && detailBlockNumber !== null) {
    if (indexedBlock > detailBlockNumber + maxIndexLagBlocks) return 'stale'
    // An index checkpoint that is itself stale can prove a backend STALE
    // (above) but cannot prove it fresh: the comparison loses power.
    return state.degradedReason === 'index-stale' ? 'unknown' : 'fresh'
  }
  if (state.degradedReason === 'node-stale') return 'stale'
  return 'unknown'
}

interface OtcFreshnessNoticeProps {
  freshness: OtcNodeFreshness
  loading: boolean
  failed: boolean
}

export function OtcFreshnessNotice({ freshness, loading, failed }: OtcFreshnessNoticeProps): ReactNode {
  if (freshness === 'stale') {
    return (
      <Callout tone="warning" title="Network data may be outdated">
        <p>
          The backend that served this order appears to be behind the network. The order state below was verified
          on-chain but may not reflect the latest blocks.
        </p>
      </Callout>
    )
  }
  if (freshness === 'unknown' && !loading && !failed) {
    return (
      <Callout tone="warning" title="Freshness could not be assessed">
        <p>
          The independent freshness comparison is unavailable right now. The order below passed direct on-chain
          verification at the shown block, but it may not reflect the latest network state.
        </p>
      </Callout>
    )
  }
  return null
}
