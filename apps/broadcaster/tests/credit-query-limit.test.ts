import { describe, expect, it } from 'vitest'
import { CreditQueryLimit } from '../src/credit-query-limit'
import { pooledCreditReads } from '../src/credit-read-pool'

describe('prepaid query isolation', () => {
  it('keeps funded recovery usable after the entire unfunded budget is consumed', () => {
    const limit = new CreditQueryLimit()
    for (let n = 0; n < 300; n++) limit.accept(`unfunded-${n}`, false, 'balance', 1)
    expect(() => limit.accept('another', false, 'balance', 1)).toThrow('Unfunded')
    expect(() => limit.accept('funded', true, 'refund-status', 1)).not.toThrow()
  })
  it('isolates expensive queries and recovery between owners', () => {
    const limit = new CreditQueryLimit()
    for (let n = 0; n < 6; n++) limit.accept('first', true, 'quote', 1)
    expect(() => limit.accept('first', true, 'quote', 1)).toThrow('refresh')
    expect(() => limit.accept('first', true, 'recover', 1)).not.toThrow()
    expect(() => limit.accept('second', true, 'quote', 1)).not.toThrow()
    expect(() => limit.accept('first', true, 'quote', 60_001)).not.toThrow()
  })
  it('enforces the recovery limit per owner, without extending the original window', () => {
    const limit = new CreditQueryLimit()
    for (let n = 0; n < 30; n++) limit.accept('first', true, 'balance', 1)
    expect(() => limit.accept('FIRST', true, 'attempt', 50_000)).toThrow('owner query')
    expect(() => limit.accept('second', true, 'attempt', 50_000)).not.toThrow()
    expect(() => limit.accept('first', true, 'attempt', 60_001)).not.toThrow()
  })
})

describe('bounded credit RPC concurrency', () => {
  it('runs independent reads in parallel with a hard16-worker cap and stable result order', async () => {
    let active = 0, peak = 0
    const results = await pooledCreditReads(Array.from({ length: 65 }, (_, n) => n), async (value) => {
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active--; return value * 2
    })
    expect(peak).toBe(16); expect(active).toBe(0)
    expect(results).toEqual(Array.from({ length: 65 }, (_, n) => n * 2))
  })
  it('stops scheduling after a failed read and drains its existing workers', async () => {
    let started = 0, completed = 0
    await expect(pooledCreditReads(Array.from({ length: 100 }, (_, n) => n), async (value) => {
      started++
      if (value === 0) throw new Error('unavailable')
      await new Promise((resolve) => setTimeout(resolve, 1)); completed++; return value
    })).rejects.toThrow('unavailable')
    expect(started).toBeLessThanOrEqual(16); expect(completed).toBe(started - 1)
  })
})
