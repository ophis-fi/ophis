import { assessDetailFreshness } from './otcDetailFreshness.utils'

import type { OtcDataState } from 'ophis/otc'

const MAX_LAG = 60n

function state(overrides: Partial<OtcDataState> = {}): OtcDataState {
  return {
    status: 'ready',
    degradedReason: null,
    snapshot: null,
    enrichment: { byOrderId: new Map(), indexedBlock: 1_000n },
    reconciliation: null,
    indexLagBlocks: 0n,
    ...overrides,
  }
}

describe('assessDetailFreshness', () => {
  it('compares the index checkpoint against the DETAIL read block, not the list snapshot', () => {
    // list hook saw a fresh backend, but the detail read landed on one 100 blocks behind
    expect(assessDetailFreshness(state(), 900n, MAX_LAG)).toBe('stale')
    expect(assessDetailFreshness(state(), 990n, MAX_LAG)).toBe('fresh')
    expect(assessDetailFreshness(state(), 1_050n, MAX_LAG)).toBe('fresh')
  })

  it('cannot certify freshness from a checkpoint the detail read has outrun', () => {
    // detail block 1061 proves the index checkpoint (1000) is > 60 blocks old
    expect(assessDetailFreshness(state(), 1_061n, MAX_LAG)).toBe('unknown')
    expect(assessDetailFreshness(state(), 1_060n, MAX_LAG)).toBe('fresh')
  })

  it('cannot certify freshness from an index checkpoint that is itself stale', () => {
    const stale = state({ status: 'degraded', degradedReason: 'index-stale', indexLagBlocks: 500n })
    expect(assessDetailFreshness(stale, 1_010n, MAX_LAG)).toBe('unknown')
    // ...but can still prove staleness when the old checkpoint is ahead anyway
    expect(assessDetailFreshness(stale, 900n, MAX_LAG)).toBe('stale')
  })

  it('falls back to the list verdict only when the direct comparison is impossible', () => {
    const nodeStale = state({ status: 'degraded', degradedReason: 'node-stale' })
    expect(assessDetailFreshness(nodeStale, null, MAX_LAG)).toBe('stale')
    // both known: the detail backend's own position wins over the list verdict
    expect(assessDetailFreshness(nodeStale, 990n, MAX_LAG)).toBe('fresh')
  })

  it('is unknown, never silently fresh, when the assessment is impossible', () => {
    const noIndex = state({ status: 'degraded', degradedReason: 'index-unavailable', enrichment: null })
    expect(assessDetailFreshness(noIndex, 990n, MAX_LAG)).toBe('unknown')
    const unavailable = state({ status: 'unavailable', enrichment: null })
    expect(assessDetailFreshness(unavailable, 990n, MAX_LAG)).toBe('unknown')
    expect(assessDetailFreshness(state(), null, MAX_LAG)).toBe('unknown')
  })
})
