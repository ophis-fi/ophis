import { runBasketPlacement, PlacedLeg } from './placement'

interface Leg {
  id: number
}

const legs: Leg[] = [{ id: 1 }, { id: 2 }, { id: 3 }]

describe('runBasketPlacement', () => {
  it('places every leg in order when nothing aborts or fails', async () => {
    const placedOrder: number[] = []
    let cancelCalls = 0
    const result = await runBasketPlacement<Leg>({
      legs,
      placeLeg: async (leg) => {
        placedOrder.push(leg.id)
        return `uid-${leg.id}`
      },
      cancelLegs: async () => {
        cancelCalls++
      },
    })
    expect(placedOrder).toEqual([1, 2, 3])
    expect(result.placed.map((p) => p.orderUid)).toEqual(['uid-1', 'uid-2', 'uid-3'])
    expect(result.aborted).toBe(false)
    expect(result.cancelled).toBe(false)
    expect(cancelCalls).toBe(0)
  })

  it('aborts before a leg and cancels the already-placed legs', async () => {
    const signal = { aborted: false }
    let cancelled: PlacedLeg<Leg>[] = []
    const result = await runBasketPlacement<Leg>({
      legs,
      placeLeg: async (leg) => {
        if (leg.id === 2) signal.aborted = true // user aborts after leg 1 is placed
        return `uid-${leg.id}`
      },
      cancelLegs: async (placed) => {
        cancelled = [...placed]
      },
      signal,
    })
    // leg 1 placed, leg 2 placed, then abort seen before leg 3 -> cancel placed 1 & 2
    expect(result.aborted).toBe(true)
    expect(result.cancelled).toBe(true)
    expect(cancelled.map((p) => p.orderUid)).toEqual(['uid-1', 'uid-2'])
  })

  it('cancels the already-placed legs when a later leg fails to sign', async () => {
    let cancelled: PlacedLeg<Leg>[] = []
    const failed: number[] = []
    const result = await runBasketPlacement<Leg>({
      legs,
      placeLeg: async (leg) => {
        if (leg.id === 3) throw new Error('user rejected signature')
        return `uid-${leg.id}`
      },
      cancelLegs: async (placed) => {
        cancelled = [...placed]
      },
      onLegFailed: (leg) => failed.push(leg.id),
      signal: { aborted: false },
    })
    expect(result.failedAt).toBe(2) // 0-based index of leg 3
    expect(result.cancelled).toBe(true)
    expect(failed).toEqual([3])
    expect(cancelled.map((p) => p.orderUid)).toEqual(['uid-1', 'uid-2'])
    expect(result.error).toBeInstanceOf(Error)
  })

  it('does not cancel when the first leg fails (nothing placed yet)', async () => {
    let cancelCalls = 0
    const result = await runBasketPlacement<Leg>({
      legs,
      placeLeg: async () => {
        throw new Error('nope')
      },
      cancelLegs: async () => {
        cancelCalls++
      },
    })
    expect(result.failedAt).toBe(0)
    expect(result.cancelled).toBe(false)
    expect(cancelCalls).toBe(0)
  })

  it('swallows a cancellation error so it never masks the original abort', async () => {
    const signal = { aborted: true } // abort before any leg
    const result = await runBasketPlacement<Leg>({
      legs,
      placeLeg: async (leg) => `uid-${leg.id}`,
      cancelLegs: async () => {
        throw new Error('cancel failed')
      },
      signal,
    })
    // aborted immediately, nothing placed -> no cancel attempted, no throw
    expect(result.aborted).toBe(true)
    expect(result.placed).toHaveLength(0)
  })
})
