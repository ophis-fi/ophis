import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ValidationCloudBudget } from './budget'
import { validationCloudCU } from '../rpc-policy'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  constructor(public ctx: unknown, public env: unknown) {}
} }))

const databases: DatabaseSync[] = []
function fixture() {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const storage = {
    sql: { exec(query: string, ...params: (string | number)[]) {
      const statement = db.prepare(query)
      const rows = query.startsWith('SELECT') ? statement.all(...params) : (statement.run(...params), [])
      return { one: () => rows[0], toArray: () => rows }
    } },
    transactionSync<T>(callback: () => T): T {
      db.exec('BEGIN')
      try { const result = callback(); db.exec('COMMIT'); return result }
      catch (error) { db.exec('ROLLBACK'); throw error }
    },
  }
  const restart = () => Reflect.construct(ValidationCloudBudget, [{ storage }, {}]) as ValidationCloudBudget
  return { db, meter: restart(), restart }
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.useRealTimers() })

it('counts every method in a batch and preserves one shared budget across restarts', () => {
  const { meter, restart } = fixture()
  expect(meter.consume(['eth_call', 'debug_traceCall', 'eth_chainId'])).toEqual({ allowed: true, remainingCU: 40_000_000 - 130 })
  expect(restart().consume(['eth_getLogs'])).toEqual({ allowed: true, remainingCU: 40_000_000 - 210 })
  expect(validationCloudCU('eth_feeHistory')).toBeUndefined()
  expect(validationCloudCU('eth_maxPriorityFeePerGas')).toBe(80)
  expect(validationCloudCU('hardhat_metadata')).toBeUndefined()
  expect(() => meter.consume(['eth_feeHistory'])).toThrow(/verified CU/)
  expect(() => meter.consume([])).toThrow()
  expect(() => meter.consume(Array(21).fill('eth_call'))).toThrow()
})

it('reserves before sending and never overspends the combined 40m monthly allocation', () => {
  const { db, meter } = fixture()
  const month = new Date().toISOString().slice(0, 7)
  db.prepare('INSERT INTO usage(month, cu) VALUES(?, ?)').run(month, 39_999_960)
  expect(meter.consume(['eth_call'])).toEqual({ allowed: true, remainingCU: 0 })
  expect(meter.consume(['eth_chainId'])).toMatchObject({ allowed: false, remainingCU: 0 })
  expect(db.prepare('SELECT cu FROM usage').get()?.cu).toBe(40_000_000)
})

it('resets the shared allocation on the first UTC day of the next calendar month', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-31T23:59:59Z'))
  const { db, meter } = fixture()
  db.prepare('INSERT INTO usage(month, cu) VALUES(?, ?)').run('2026-10', 40_000_000)
  expect(meter.consume(['eth_call']).allowed).toBe(false)
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  expect(meter.consume(['debug_traceCall'])).toEqual({ allowed: true, remainingCU: 39_999_920 })
  expect(db.prepare('SELECT month FROM usage').get()?.month).toBe('2026-11')
})

it('shares a 60 logical requests/second limit across batches without charging rejected calls', () => {
  vi.useFakeTimers()
  const { db, meter } = fixture()
  for (let i = 0; i < 3; i++) expect(meter.consume(Array(20).fill('eth_chainId')).allowed).toBe(true)
  expect(meter.consume(['eth_call'])).toMatchObject({ allowed: false, reason: expect.stringMatching(/rate/) })
  expect(db.prepare('SELECT cu FROM usage').get()?.cu).toBe(600)
  vi.advanceTimersByTime(1000)
  expect(meter.consume(['eth_call'])).toEqual({ allowed: true, remainingCU: 39_999_360 })
})

it('does not refill a full burst just because the wall-clock second changes', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-28T00:00:00.999Z'))
  const { meter } = fixture()
  for (let i = 0; i < 3; i++) expect(meter.consume(Array(20).fill('eth_chainId')).allowed).toBe(true)
  vi.advanceTimersByTime(2)
  expect(meter.consume(['eth_chainId']).allowed).toBe(false)
  vi.advanceTimersByTime(1000)
  expect(meter.consume(['eth_chainId']).allowed).toBe(true)
})
