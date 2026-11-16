import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ValidationCloudBudget } from './budget'
import { alchemyCU, alchemyThroughputCU, validationCloudCU } from '../rpc-policy'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {
  constructor(public ctx: unknown, public env: unknown) {}
} }))

const databases: DatabaseSync[] = []
function fixture(env: Partial<Env> = {}) {
  const db = new DatabaseSync(':memory:')
  databases.push(db)
  const storage = {
    setAlarm: vi.fn(async () => {}), deleteAlarm: vi.fn(async () => {}),
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
  const restart = () => Reflect.construct(ValidationCloudBudget, [{ storage }, env]) as ValidationCloudBudget
  return { db, meter: restart(), restart, storage }
}
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.useRealTimers(); vi.unstubAllGlobals() })

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

it('meters Alchemy batches separately using published billing and throughput costs', () => {
  const { db, meter, restart } = fixture()
  expect(meter.consume(['eth_chainId', 'net_version', 'eth_call'], 'alchemy')).toEqual({ allowed: true, remainingCU: 23_999_974 })
  expect(db.prepare('SELECT calls FROM pace').get()?.calls).toBe(36)
  expect(restart().consume(['eth_sendRawTransaction'], 'alchemy')).toEqual({ allowed: true, remainingCU: 23_999_934 })
  expect(alchemyCU('debug_traceCall')).toBe(40)
  expect(alchemyCU('eth_getLogs')).toBe(60)
  expect(alchemyThroughputCU('eth_sendRawTransaction')).toBe(50)
  expect(alchemyThroughputCU('debug_traceCall')).toBe(1000)
  expect(meter.consume(['debug_traceCall', 'eth_getLogs'], 'alchemy')).toEqual({ allowed: true, remainingCU: 23_999_834 })
  expect(meter.consume(['debug_traceCall'], 'alchemy')).toMatchObject({ allowed: false, reason: 'Alchemy shared request rate reached.' })
  expect(() => meter.consume(['debug_traceTransaction'], 'alchemy')).toThrow(/verified CU/)
})

it('preserves the 24m Alchemy ceiling across a billing-month boundary and expires old days', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-31T23:59:59Z'))
  const { db, meter } = fixture()
  db.prepare('INSERT INTO usage(month, cu) VALUES(?, ?)').run('2026-10-01', 23_999_974)
  expect(meter.consume(['eth_call'], 'alchemy')).toEqual({ allowed: true, remainingCU: 0 })
  vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
  expect(meter.consume(['eth_blockNumber'], 'alchemy')).toMatchObject({ allowed: false, remainingCU: 0 })
  vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
  expect(meter.consume(['eth_blockNumber'], 'alchemy')).toEqual({ allowed: true, remainingCU: 23_999_964 })
})

it('paces Alchemy by shared weighted CU and charges only accepted requests', () => {
  vi.useFakeTimers()
  const { db, meter } = fixture()
  expect(meter.consume(Array(20).fill('eth_sendRawTransaction'), 'alchemy').allowed).toBe(true)
  expect(meter.consume(Array(20).fill('eth_chainId'), 'alchemy').allowed).toBe(true)
  expect(meter.consume(Array(20).fill('eth_chainId'), 'alchemy').allowed).toBe(true)
  expect(meter.consume(['eth_chainId'], 'alchemy').allowed).toBe(false)
  expect(db.prepare('SELECT SUM(cu) AS cu FROM usage').get()?.cu).toBe(800)
  vi.advanceTimersByTime(100)
  expect(meter.consume(['eth_chainId'], 'alchemy').allowed).toBe(true)
  expect(meter.consume(['eth_call'], 'alchemy').allowed).toBe(false)
})

const arbEndpoint = 'https://arb-mainnet.g.alchemy.com/v2/test-key'
const bnbEndpoint = 'https://bnb-mainnet.g.alchemy.com/v2/test-key'
const baseEndpoint = 'https://base-mainnet.g.alchemy.com/v2/test-key'
it('shares head reads across concurrent clients and charges only one upstream call per fifteen seconds', async () => {
  vi.useFakeTimers()
  const { db, meter } = fixture()
  const upstream = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x123' }))
  vi.stubGlobal('fetch', upstream)
  expect(await Promise.all(Array.from({ length: 20 }, () => meter.blockNumber(42161, arbEndpoint))))
    .toEqual(Array(20).fill('0x123'))
  expect(upstream).toHaveBeenCalledOnce()
  expect(db.prepare('SELECT SUM(cu) AS cu FROM usage').get()?.cu).toBe(10)
  vi.advanceTimersByTime(14999)
  expect(await meter.blockNumber(42161, arbEndpoint)).toBe('0x123')
  expect(upstream).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(1)
  await meter.blockNumber(42161, arbEndpoint)
  expect(upstream).toHaveBeenCalledTimes(2)
  expect(db.prepare('SELECT SUM(cu) AS cu FROM usage').get()?.cu).toBe(20)
})

it('isolates cached heads by chain and endpoint and never follows a redirected submission route', async () => {
  const { meter } = fixture()
  const upstream = vi.fn(async (endpoint: string) => Response.json({ jsonrpc: '2.0', id: 1,
    result: endpoint === arbEndpoint ? '0x123' : '0x456' }))
  vi.stubGlobal('fetch', upstream)
  expect(await meter.blockNumber(42161, arbEndpoint)).toBe('0x123')
  expect(await meter.blockNumber(56, bnbEndpoint)).toBe('0x456')
  expect(await meter.blockNumber(42161, arbEndpoint.replace('test-key', 'replacement-key'))).toBe('0x456')
  await expect(meter.blockNumber(56, arbEndpoint)).rejects.toThrow('endpoint')
  expect(upstream).toHaveBeenCalledTimes(3)
  for (const [, options] of upstream.mock.calls as unknown as [string, RequestInit][]) {
    expect(options.redirect).toBe('manual')
    expect(JSON.parse(options.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
  }
})

it.each([301, 302, 303, 307, 308])('rejects head HTTP %s without following its Location or retrying', async (status) => {
  const { db, meter } = fixture()
  const upstream = vi.fn(async () => new Response(null, { status, headers: { Location: 'https://untrusted.example' } }))
  vi.stubGlobal('fetch', upstream)
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow('Alchemy head unavailable.')
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow('Alchemy head unavailable.')
  expect(upstream).toHaveBeenCalledOnce()
  expect(upstream).toHaveBeenCalledWith(arbEndpoint, expect.objectContaining({ redirect: 'manual' }))
  expect(db.prepare('SELECT SUM(cu) AS cu FROM usage').get()?.cu).toBe(10)
})

it.each([
  { jsonrpc: '2.0', id: 1, result: null }, { jsonrpc: '2.0', id: 2, result: '0x1' },
  { jsonrpc: '2.0', id: 1, result: '0x20000000000000' }, { jsonrpc: '2.0', id: 1, error: { code: -32000 } },
])('rejects invalid head evidence and bounds retries during failures: %j', async (body) => {
  vi.useFakeTimers()
  const { meter } = fixture()
  const upstream = vi.fn(async () => Response.json(body))
  vi.stubGlobal('fetch', upstream)
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow()
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow()
  expect(upstream).toHaveBeenCalledOnce()
  vi.advanceTimersByTime(15_000)
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow()
  expect(upstream).toHaveBeenCalledTimes(2)
})

it('keeps the durable quota enforced after head-cache restart', async () => {
  const { db, meter, restart } = fixture()
  const day = new Date().toISOString().slice(0, 10)
  db.prepare('INSERT INTO usage(month,cu) VALUES(?,?)').run(day, 23_999_990)
  const upstream = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x123' }))
  vi.stubGlobal('fetch', upstream)
  await meter.blockNumber(42161, arbEndpoint)
  await expect(restart().blockNumber(42161, arbEndpoint)).rejects.toThrow('budget')
  expect(upstream).toHaveBeenCalledOnce()
})

it('cancels oversized head streams before buffering the rest and redacts upstream errors', async () => {
  const { meter } = fixture(), cancel = vi.fn()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1025)) }, cancel,
  }))))
  await expect(meter.blockNumber(42161, arbEndpoint)).rejects.toThrow('Alchemy head unavailable.')
  expect(cancel).toHaveBeenCalledOnce()
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error(bnbEndpoint) }))
  await expect(meter.blockNumber(56, bnbEndpoint)).rejects.toThrow(/^Alchemy head unavailable\.$/)
})

it.each([[137, 'https://polygon-mainnet.g.alchemy.com/v2/retained-key'], [8453, baseEndpoint]] as const)(
  'refuses disabled chain %s head reads without quota changes or an upstream call', async (chainId, endpoint) => {
    const { db, meter } = fixture(), upstream = vi.fn(async () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x1' }))
    vi.stubGlobal('fetch', upstream)
    await expect(meter.blockNumber(chainId, endpoint)).rejects.toThrow('Unsupported private network.')
    expect(db.prepare('SELECT * FROM usage').all()).toEqual([])
    expect(db.prepare('SELECT * FROM pace').all()).toEqual([])
    expect(upstream).not.toHaveBeenCalled()
  },
)

const retainedBaseEnv = { RAILGUN_RPC_ENABLED: 'true', RAILGUN_BASE_ALCHEMY_EXTENDED: 'true', RAILGUN_BASE_RPC_URL: baseEndpoint }
it.each(['manifest', 'page', 'tail'] as const)('refuses disabled Base %s before constructing its history cache', async method => {
  const { db, meter, storage } = fixture(retainedBaseEnv), upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const action = async () => method === 'manifest' ? meter.baseHistoryManifest()
    : method === 'page' ? meter.baseHistoryPage('ab'.repeat(32), 0) : meter.baseHistoryTail('ab'.repeat(32))
  await expect(action()).rejects.toThrow('Base history is disabled.')
  expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'pace' }, { name: 'usage' }])
  expect(storage.setAlarm).not.toHaveBeenCalled(); expect(storage.deleteAlarm).not.toHaveBeenCalled()
  expect(upstream).not.toHaveBeenCalled()
})

it.each([false, true])('disarms a persisted Base-only alarm after restart without changing history or quota (paused: %s)', async paused => {
  const { db, restart, storage } = fixture(retainedBaseEnv), upstream = vi.fn(async () => { throw new Error('Must not fetch disabled Base') })
  vi.stubGlobal('fetch', upstream)
  db.exec('CREATE TABLE base_history_state(id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  db.exec('CREATE TABLE base_history_parts(hash TEXT, part INTEGER, body TEXT)')
  db.exec('CREATE TABLE base_history_usage(day TEXT PRIMARY KEY, cu INTEGER NOT NULL)')
  db.exec('CREATE TABLE base_history_tail(id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  db.prepare('INSERT INTO base_history_state(id,body) VALUES(1,?)').run(JSON.stringify({ scheduled: true, nextAttempt: 0,
    ...(paused ? { retryAt: Date.now() + 60_000 } : {}) }))
  db.prepare('INSERT INTO base_history_parts(hash,part,body) VALUES(?,0,?)').run('ab'.repeat(32), 'saved-public-history')
  db.prepare('INSERT INTO base_history_usage(day,cu) VALUES(?,?)').run('history:2026-11-16', 1234)
  db.prepare('INSERT INTO base_history_tail(id,body) VALUES(1,?)').run('saved-tail')
  const tables = ['usage', 'pace', 'base_history_state', 'base_history_parts', 'base_history_usage', 'base_history_tail']
  const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all())
  const before = snapshot()
  await restart().alarm()
  expect(storage.deleteAlarm).toHaveBeenCalledOnce(); expect(storage.setAlarm).not.toHaveBeenCalled()
  expect(snapshot()).toEqual(before); expect(upstream).not.toHaveBeenCalled()
})
