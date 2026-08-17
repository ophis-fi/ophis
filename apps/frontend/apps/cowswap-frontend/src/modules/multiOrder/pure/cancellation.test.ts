import { isCancellableStatus, runLegCancellation, CancelCandidate } from './cancellation'

import { BasketLegStatus } from '../types'

// Minimal live-status store for the injected getStatus/setStatus.
function makeStore(initial: Record<number, BasketLegStatus>): {
  getStatus(leg: number): BasketLegStatus | undefined
  setStatus(leg: number, status: BasketLegStatus): void
  snapshot(): Record<string, BasketLegStatus>
} {
  const state = new Map<number, BasketLegStatus>(Object.entries(initial).map(([k, v]) => [Number(k), v]))
  return {
    getStatus: (leg: number) => state.get(leg),
    setStatus: (leg: number, status: BasketLegStatus) => {
      state.set(leg, status)
    },
    snapshot: () => Object.fromEntries(state),
  }
}

const candidates = (legs: number[]): CancelCandidate[] => legs.map((leg) => ({ leg, orderUid: `uid-${leg}` }))

describe('isCancellableStatus', () => {
  it('includes cancelling (retry eligibility) and excludes terminal states', () => {
    expect(isCancellableStatus('open')).toBe(true)
    expect(isCancellableStatus('signing')).toBe(true)
    expect(isCancellableStatus('cancelling')).toBe(true) // rejected-cancel retry
    expect(isCancellableStatus('filled')).toBe(false)
    expect(isCancellableStatus('cancelled')).toBe(false)
    expect(isCancellableStatus('expired')).toBe(false)
    expect(isCancellableStatus('failed')).toBe(false)
    expect(isCancellableStatus('pending')).toBe(false)
  })
})

describe('runLegCancellation', () => {
  it('cancels the open/signing legs on a successful cancel', async () => {
    const store = makeStore({ 1: 'open', 2: 'signing', 3: 'open' })
    let cancelledArg: CancelCandidate[] = []
    const result = await runLegCancellation({
      candidates: candidates([1, 2, 3]),
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async (legs) => {
        cancelledArg = [...legs]
      },
    })
    expect(cancelledArg.map((c) => c.leg)).toEqual([1, 2, 3])
    expect(result.attempted).toEqual([1, 2, 3])
    expect(result.cancelled).toEqual([1, 2, 3])
    expect(store.snapshot()).toEqual({ 1: 'cancelled', 2: 'cancelled', 3: 'cancelled' })
  })

  it('does NOT mark a leg that filled mid-placement as cancelled (skips it entirely)', async () => {
    // Leg 2 filled during the placement window before the abort-cancel ran.
    const store = makeStore({ 1: 'open', 2: 'filled', 3: 'open' })
    let cancelledArg: CancelCandidate[] = []
    const result = await runLegCancellation({
      candidates: candidates([1, 2, 3]), // abort tries to cancel all placed legs
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async (legs) => {
        cancelledArg = [...legs]
      },
    })
    // Only the still-open legs are attempted; the filled leg is never touched.
    expect(cancelledArg.map((c) => c.leg)).toEqual([1, 3])
    expect(result.attempted).toEqual([1, 3])
    expect(store.getStatus(2)).toBe('filled') // NOT a display lie
    expect(store.snapshot()).toEqual({ 1: 'cancelled', 2: 'filled', 3: 'cancelled' })
  })

  it('leaves a leg that fills DURING the cancel round-trip as filled, not cancelled', async () => {
    const store = makeStore({ 1: 'open', 2: 'open' })
    const result = await runLegCancellation({
      candidates: candidates([1, 2]),
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async () => {
        // A fill for leg 2 lands while the cancel is in flight.
        store.setStatus(2, 'filled')
      },
    })
    expect(result.cancelled).toEqual([1]) // leg 2 not force-cancelled
    expect(store.getStatus(1)).toBe('cancelled')
    expect(store.getStatus(2)).toBe('filled')
  })

  it('leaves legs at cancelling (retryable) when the cancel is rejected', async () => {
    const store = makeStore({ 1: 'open', 2: 'signing' })
    const result = await runLegCancellation({
      candidates: candidates([1, 2]),
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async () => {
        throw new Error('user declined the cancel signature')
      },
    })
    expect(result.cancelled).toEqual([])
    expect(result.attempted).toEqual([1, 2])
    // Both stuck at 'cancelling', which IS a cancellable status -> retryable.
    expect(store.getStatus(1)).toBe('cancelling')
    expect(store.getStatus(2)).toBe('cancelling')
    expect(isCancellableStatus(store.getStatus(1)!)).toBe(true)
    expect(isCancellableStatus(store.getStatus(2)!)).toBe(true)
  })

  it('re-attempts legs left at cancelling on a follow-up call (in-session retry)', async () => {
    const store = makeStore({ 1: 'cancelling', 2: 'cancelling' })
    const result = await runLegCancellation({
      candidates: candidates([1, 2]),
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async () => undefined, // retry succeeds this time
    })
    expect(result.cancelled).toEqual([1, 2])
    expect(store.snapshot()).toEqual({ 1: 'cancelled', 2: 'cancelled' })
  })

  it('is a no-op when no candidate is cancellable (all terminal)', async () => {
    const store = makeStore({ 1: 'filled', 2: 'cancelled', 3: 'failed' })
    let cancelCalled = false
    const result = await runLegCancellation({
      candidates: candidates([1, 2, 3]),
      getStatus: store.getStatus,
      setStatus: store.setStatus,
      cancel: async () => {
        cancelCalled = true
      },
    })
    expect(cancelCalled).toBe(false)
    expect(result.attempted).toEqual([])
    expect(result.cancelled).toEqual([])
    expect(store.snapshot()).toEqual({ 1: 'filled', 2: 'cancelled', 3: 'failed' })
  })
})
