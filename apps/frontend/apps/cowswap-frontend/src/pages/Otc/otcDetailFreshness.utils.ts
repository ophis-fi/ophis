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
    // A checkpoint the detail read has provably outrun — or one the list
    // comparison already found stale — can prove a backend STALE (above) but
    // cannot certify it fresh: the evidence itself is too old.
    if (detailBlockNumber > indexedBlock + maxIndexLagBlocks) return 'unknown'
    return state.degradedReason === 'index-stale' ? 'unknown' : 'fresh'
  }
  if (state.degradedReason === 'node-stale') return 'stale'
  return 'unknown'
}
