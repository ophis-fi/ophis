import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { id } from 'ethers'
import { BaseHistoryCache, baseHistoryResponse } from './history'
import { BASE_HISTORY as B, historyDigest, validateHistoryManifest } from '../base-history'
import { alchemyCU } from '../rpc-policy'

const databases: DatabaseSync[] = []
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers() })
function fixture(finalized = B.fromBlock + 249_999) {
  const db = new DatabaseSync(':memory:'); databases.push(db)
  const setAlarm = vi.fn(async () => {})
  const storage = { setAlarm, sql: { exec(query: string, ...params: unknown[]) {
    const statement = db.prepare(query), rows = query.startsWith('SELECT') ? statement.all(...params as any[]) : (statement.run(...params as any[]), [])
    return { toArray: () => rows, one: () => rows[0] }
  } }, transactionSync<T>(callback: () => T): T {
    db.exec('BEGIN'); try { const result = callback(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  } } as unknown as DurableObjectStorage
  const env = { RAILGUN_RPC_ENABLED: 'true', RAILGUN_BASE_ALCHEMY_EXTENDED: 'true',
    RAILGUN_BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/synthetic-test' } as Env
  const consume = vi.fn(() => ({ allowed: true }))
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    expect(options?.redirect).toBe('manual')
    const { method, params } = JSON.parse(String(options?.body))
    expect(consume).toHaveBeenCalled()
    const number = method !== 'eth_getBlockByNumber' ? 0 : params[0] === 'finalized' ? finalized : params[0] === 'latest' ? finalized + 9 : Number(BigInt(params[0]))
    const result = method === 'eth_chainId' ? '0x2105' : method === 'eth_getLogs' ? [] :
      { number: `0x${number.toString(16)}`, hash: id(`block:${number}`), timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` }
    return Response.json({ jsonrpc: '2.0', id: 1, result })
  })
  vi.stubGlobal('fetch', fetch)
  const restart = () => new BaseHistoryCache(storage, env, consume)
  return { db, storage, env, consume, fetch, setAlarm, finalized, cache: restart(), restart }
}
async function warm(f: ReturnType<typeof fixture>) {
  await f.cache.manifest(); await f.cache.alarm(); await f.cache.alarm()
  const manifest = await f.cache.manifest()
  expect(manifest).toBeDefined()
  return manifest!
}

it('coalesces cold readers and alarms, publishes all empty ranges atomically, then serves zero-CU pages', async () => {
  const f = fixture()
  expect(await Promise.all(Array.from({ length: 20 }, () => f.cache.manifest()))).toEqual(Array(20).fill(undefined))
  expect(f.setAlarm).toHaveBeenCalledOnce()
  await Promise.all([f.cache.alarm(), f.cache.alarm()])
  expect(await f.cache.manifest()).toBeUndefined()
  expect(f.fetch.mock.calls.filter(([, options]) => JSON.parse(String(options?.body)).method === 'eth_getLogs')).toHaveLength(2)
  await f.cache.alarm()
  const manifest = await f.cache.manifest()
  expect(await validateHistoryManifest(manifest)).toMatchObject({ toBlock: f.finalized, pages: [{ count: 0 }, { count: 0 }, { count: 0 }] })
  const calls = f.fetch.mock.calls.length
  for (const [index, page] of manifest!.pages.entries()) {
    const body = f.restart().page(manifest!.generation, index)!
    expect(body).toBe('[]'); expect(await historyDigest(body)).toBe(page.hash)
  }
  expect(f.fetch).toHaveBeenCalledTimes(calls)
  expect(f.cache.page('x', 0)).toBeUndefined(); expect(f.cache.page(manifest!.generation, 999)).toBeUndefined()
  expect(f.fetch).toHaveBeenCalledTimes(calls)
})

it('preserves pending warmup across restart and never exposes staged pages', async () => {
  const f = fixture(); await f.cache.manifest(); await f.cache.alarm()
  expect(f.cache.page(id('not a committed generation').slice(2), 0)).toBeUndefined()
  const next = f.restart(); expect(await next.manifest()).toBeUndefined()
  await next.alarm()
  expect((await next.manifest())?.pages).toHaveLength(3)
  expect(f.fetch.mock.calls.filter(([, options]) => JSON.parse(String(options?.body)).method === 'eth_getLogs')).toHaveLength(3)
})

it('resumes a 168-page cold scan after the UTC daily allowance resets without rereading completed pages', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
  const f = fixture(B.fromBlock + 168 * B.width - 1)
  await f.cache.manifest()
  for (let index = 0; index < 84; index++) await f.cache.alarm()
  const before = f.fetch.mock.calls.length
  const saved = JSON.parse(String(f.db.prepare('SELECT body FROM base_history_state WHERE id=1').get()?.body))
  expect(saved.job.pages).toHaveLength(166)
  expect(saved.retryAt).toBe(Date.parse('2026-11-17T00:00:00Z'))
  expect(await f.restart().manifest()).toBeUndefined()
  await f.restart().alarm()
  expect(f.fetch).toHaveBeenCalledTimes(before)
  expect(f.db.prepare('SELECT cu FROM base_history_usage WHERE day=?').get('history:2026-11-16')?.cu).toBeLessThanOrEqual(10_000)
  vi.setSystemTime(new Date('2026-11-17T00:00:01Z'))
  const restarted = f.restart(); await restarted.alarm()
  const manifest = await restarted.manifest()
  expect((await validateHistoryManifest(manifest)).pages).toHaveLength(168)
  const pages = f.fetch.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))
    .filter(request => request.method === 'eth_getLogs')
  expect(pages).toHaveLength(168)
  expect(new Set(pages.map(request => request.params[0].fromBlock)).size).toBe(168)
})

it('retains progress on shared-budget refusal but discards it if the resumed anchor is no longer canonical', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
  const f = fixture(), original = f.fetch.getMockImplementation()!
  await f.cache.manifest(); await f.cache.alarm()
  f.consume.mockReturnValue({ allowed: false })
  await f.cache.alarm()
  const readState = () => JSON.parse(String(f.db.prepare('SELECT body FROM base_history_state WHERE id=1').get()?.body))
  expect(readState().job.pages).toHaveLength(2)
  const calls = f.fetch.mock.calls.length
  await f.restart().alarm()
  expect(f.fetch).toHaveBeenCalledTimes(calls)
  vi.setSystemTime(Date.now() + B.refreshMs)
  f.consume.mockReturnValue({ allowed: true })
  f.fetch.mockImplementation(async (url, options) => {
    const request = JSON.parse(String(options?.body)), value = await (await original(url, options)).json() as { result: any }
    if (request.method === 'eth_getBlockByNumber') value.result.hash = id('changed anchor')
    return Response.json(value)
  })
  await f.restart().alarm()
  expect(readState().job).toBeUndefined()
  expect(await f.restart().manifest()).toBeUndefined()
  expect(f.db.prepare('SELECT COUNT(*) AS count FROM base_history_parts').get()?.count).toBe(0)
  expect(f.fetch.mock.calls.filter(([, options]) => JSON.parse(String(options?.body)).method === 'eth_getLogs')).toHaveLength(3)
})

it('re-arms a persisted budget pause after the alarm write fails, without another RPC attempt', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-16T12:00:00Z'))
  const f = fixture()
  await f.cache.manifest(); await f.cache.alarm()
  f.db.prepare('UPDATE base_history_usage SET cu=9990 WHERE day=?').run('history:2026-11-16')
  f.setAlarm.mockRejectedValueOnce(new Error('synthetic alarm write failure'))
  await expect(f.cache.alarm()).rejects.toThrow('alarm write failure')
  const calls = f.fetch.mock.calls.length
  await f.restart().alarm()
  expect(f.setAlarm).toHaveBeenLastCalledWith(Date.parse('2026-11-17T00:00:00Z'))
  expect(f.fetch).toHaveBeenCalledTimes(calls)
  const state = JSON.parse(String(f.db.prepare('SELECT body FROM base_history_state WHERE id=1').get()?.body))
  expect(state.job.pages).toHaveLength(2)
})

it.each(['canonical-anchor', 'oversized-page', 'wrong-chain', 'budget', 'redirect'])('does not publish or retry silently after %s failure', async reason => {
  const f = fixture(), original = f.fetch.getMockImplementation()!
  f.fetch.mockImplementation(async (url, options) => {
    if (reason === 'redirect') return new Response(null, { status: 307, headers: { Location: 'https://untrusted.example' } })
    const request = JSON.parse(String(options?.body)), response = await original(url, options), value = await response.json() as { result: any }
    if (reason === 'wrong-chain' && request.method === 'eth_chainId') value.result = '0x1'
    if (reason === 'canonical-anchor' && request.method === 'eth_getBlockByNumber' && request.params[0] !== 'finalized') value.result.hash = id('changed')
    if (reason === 'oversized-page' && request.method === 'eth_getLogs') value.result = [{ address: B.address,
      blockNumber: request.params[0].fromBlock, blockHash: id('block'), transactionHash: id('tx'), transactionIndex: '0x0',
      logIndex: '0x0', topics: [id('event')], data: '0x' + 'ab'.repeat(B.pageBytes), removed: false }]
    return Response.json(value)
  })
  if (reason === 'budget') f.consume.mockReturnValue({ allowed: false })
  await f.cache.manifest(); await f.cache.alarm(); await f.cache.alarm()
  expect(await f.cache.manifest()).toBeUndefined()
  const calls = f.fetch.mock.calls.length, alarms = f.setAlarm.mock.calls.length
  await f.restart().manifest()
  await f.restart().alarm()
  expect(f.fetch).toHaveBeenCalledTimes(calls); expect(f.setAlarm).toHaveBeenCalledTimes(alarms + (reason === 'budget' ? 1 : 0))
  if (reason === 'budget') expect(f.fetch).not.toHaveBeenCalled()
})

it('rejects a nullifier-only orphan log even when both interval anchors are canonical', async () => {
  const f = fixture(), manifest = await warm(f), original = f.fetch.getMockImplementation()!
  f.fetch.mockImplementation(async (url, options) => {
    const request = JSON.parse(String(options?.body))
    if (request.method === 'eth_getLogs') return Response.json({ jsonrpc: '2.0', id: 1, result: [{ address: B.address,
      blockNumber: `0x${(f.finalized + 1).toString(16)}`, blockHash: id('orphan'), transactionHash: id('tx'),
      transactionIndex: '0x0', logIndex: '0x0', topics: [id('Nullified(uint16,bytes32[])')], data: '0x', removed: false }] })
    return original(url, options)
  })
  await expect(f.cache.recent(manifest.generation)).rejects.toThrow('orphaned')
  await expect(f.restart().recent(manifest.generation)).rejects.toThrow('warming')
})

it('shares one pinned recent tail including zero logs, across readers and process restart', async () => {
  const f = fixture(), manifest = await warm(f), initial = f.fetch.mock.calls.length
  const results = await Promise.all(Array.from({ length: 8 }, () => f.cache.recent(manifest.generation)))
  expect(results.every(result => result.blockHash === id(`block:${f.finalized + 9}`) && result.logs.length === 0)).toBe(true)
  expect(f.fetch.mock.calls.length - initial).toBe(4)
  expect(await f.restart().recent(manifest.generation)).toEqual(results[0])
  expect(f.fetch.mock.calls.length - initial).toBe(4)
  await expect(f.cache.recent('0'.repeat(64))).rejects.toThrow('generation')
  expect(f.fetch.mock.calls.length - initial).toBe(4)
})

it.each([false, true])('reuses only a canonical same-generation prefix (reorg=%s)', async reorg => {
  const f = fixture(), manifest = await warm(f), first = await f.cache.recent(manifest.generation)
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31_000)
  const original = f.fetch.getMockImplementation()!, start = f.fetch.mock.calls.length
  f.fetch.mockImplementation(async (url, options) => {
    const request = JSON.parse(String(options?.body)), value = await (await original(url, options)).json() as { result: any }
    if (request.method === 'eth_getBlockByNumber' && request.params[0] === 'latest')
      value.result = { ...value.result, number: `0x${(first.toBlock + 10).toString(16)}`, hash: id(`block:${first.toBlock + 10}`) }
    if (reorg && request.method === 'eth_getBlockByNumber' && request.params[0] === `0x${first.toBlock.toString(16)}`) value.result.hash = id('reorg')
    return Response.json(value)
  })
  const next = await f.restart().recent(manifest.generation)
  const calls = f.fetch.mock.calls.slice(start).map(([, options]) => JSON.parse(String(options?.body)))
  expect(calls.find(value => value.method === 'eth_getLogs').params[0].fromBlock)
    .toBe(`0x${(reorg ? manifest.toBlock + 1 : first.toBlock + 1).toString(16)}`)
  expect(next.toBlock).toBe(first.toBlock + 10)
  expect(calls).toHaveLength(reorg ? 5 : 4)
})

it('does not splice a previous tail across a manifest generation change', async () => {
  const f = fixture(), first = await warm(f)
  await f.cache.recent(first.generation)
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + B.refreshMs + 1)
  await f.cache.manifest(); await f.cache.alarm()
  const next = await f.cache.manifest()
  expect(next!.generation).not.toBe(first.generation)
  const start = f.fetch.mock.calls.length
  await f.cache.recent(next!.generation)
  const calls = f.fetch.mock.calls.slice(start).map(([, options]) => JSON.parse(String(options?.body)))
  expect(calls.find(value => value.method === 'eth_getLogs').params[0].fromBlock).toBe(`0x${(next!.toBlock + 1).toString(16)}`)
  expect(calls).toHaveLength(4)
})

it('keeps an in-flight tail authoritative beyond TTL and persists a lease before its first read', async () => {
  const f = fixture(), manifest = await warm(f), original = f.fetch.getMockImplementation()!
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  f.fetch.mockImplementationOnce(async (url, options) => { await pending; return original(url, options) })
  const first = f.cache.recent(manifest.generation)
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 31_000)
  const second = f.cache.recent(manifest.generation)
  await expect(f.restart().recent(manifest.generation)).rejects.toThrow('warming')
  const calls = f.fetch.mock.calls.length
  release(); expect(await second).toEqual(await first)
  expect(f.fetch.mock.calls.length - calls).toBe(3)
})

it('reserves and retains sublimit consumption across failed attempts and restarts', async () => {
  const f = fixture(), manifest = await warm(f), day = new Date().toISOString().slice(0, 10)
  f.db.prepare('INSERT INTO base_history_usage(day,cu) VALUES(?,?)').run(`tail:${day}`, 349_990)
  const before = f.fetch.mock.calls.length
  await expect(f.cache.recent(manifest.generation)).rejects.toThrow('daily budget')
  expect(f.fetch).toHaveBeenCalledTimes(before)
  expect(f.db.prepare('SELECT cu FROM base_history_usage WHERE day=?').get(`tail:${day}`)?.cu).toBe(349_990)
  await expect(f.restart().recent(manifest.generation)).rejects.toThrow('warming')
  const cost = ['eth_getBlockByNumber', 'eth_getLogs', 'eth_getBlockByNumber', 'eth_getBlockByNumber'].reduce((sum, method) => sum + alchemyCU(method)!, 0)
  expect(cost).toBe(120); expect(86_400 / 30 * cost).toBeLessThan(350_000)
})

it('rejects invalid public routes, input and foreign origins without starting paid work', async () => {
  const f = fixture(), stub = { baseHistoryManifest: vi.fn(), baseHistoryPage: vi.fn(), baseHistoryTail: vi.fn() }
  Object.assign(f.env, { RPC_LIMIT: { limit: async () => ({ success: true }) }, VALIDATION_CLOUD_BUDGET: { getByName: () => stub } })
  for (const request of [new Request('https://swap.ophis.fi/rpc/history/base/manifest?from=0'),
    new Request('https://swap.ophis.fi/rpc/history/base/tail/bad'),
    new Request('https://swap.ophis.fi/rpc/history/base/manifest', { headers: { Origin: 'https://other.invalid' } })])
    expect((await baseHistoryResponse(request, f.env)).status).toBeGreaterThanOrEqual(400)
  expect(f.fetch).not.toHaveBeenCalled(); expect(stub.baseHistoryManifest).not.toHaveBeenCalled()
})
