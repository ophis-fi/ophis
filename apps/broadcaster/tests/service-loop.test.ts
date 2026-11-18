import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { WakuRelay } from '../src/waku'

// Execute the actual loop with fake I/O; importing main would start custody and SDK initialization.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const loops: ts.WhileStatement[] = []
const health: ts.ArrowFunction[] = []
function visit(node: ts.Node): void {
  if (ts.isWhileStatement(node) && node.getText(source).includes('waku!.dispatch(')) loops.push(node)
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'createServer' && ts.isArrowFunction(node.arguments[0])) health.push(node.arguments[0])
  ts.forEachChild(node, visit)
}
visit(source)
if (loops.length !== 1) throw new Error('Expected exactly one broadcaster dispatch loop.')
const loop = ts.transpileModule(loops[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const runLoop = new AsyncFunction('fixture', `
  const { broadcaster, sdk, waku, advance, stopAfter } = fixture;
  const config = { state: '/unused' }, command = 'run', abort = new AbortController();
  const TOPICS = { fees: 'fees' }, FEE_LIFETIME_MS = 5 * 60000, assertDisk = () => {};
  const metrics = { ready: false, feeReadyUntil: 0, errors: 0 };
  let stopping = false, lastRefresh = -Infinity, lastReconcile = -Infinity, failures = 0, syncReported = false, reconcile, refresh;
  let iterations = 0;
  const delay = async (milliseconds) => {
    fixture.observed.push({ ...metrics });
    await advance(++iterations, milliseconds); stopping = iterations === stopAfter;
  };
  ${loop}
  await refresh;
  await reconcile;
  return metrics;
`) as (input: ReturnType<typeof fixture>) => Promise<{ ready: boolean; errors: number }>

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'))
  const broadcaster = {
    reconcile: vi.fn(async () => {}),
    feeAdvertisement: vi.fn(async () => ({ available: true, message: new Uint8Array() })),
    handle: vi.fn(async (_payload: Uint8Array) => undefined),
  }
  const sdk = { ready: () => true, balances: vi.fn(async () => ({})) }
  const waku = {
    publish: vi.fn(async () => {}),
    dispatch: vi.fn(async (handle: typeof broadcaster.handle) => { await handle(new Uint8Array()) }),
  }
  return { broadcaster, sdk, waku, stopAfter: 3, observed: [] as { ready: boolean; errors: number }[], advance: vi.fn(async (_iteration: number, _milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(31_000)
  }) }
}

it.each(['balances', 'advertisement', 'publication', 'dispatch'])('keeps reconciliation and delivery running after %s failures', async (failure) => {
  const f = fixture()
  const failed = { balances: f.sdk.balances, advertisement: f.broadcaster.feeAdvertisement,
    publication: f.waku.publish, dispatch: f.waku.dispatch }[failure]!
  failed.mockRejectedValue(new Error('Dependency unavailable'))
  const metrics = await runLoop(f)
  expect(f.broadcaster.reconcile).toHaveBeenCalledTimes(3)
  expect(f.waku.dispatch).toHaveBeenCalledTimes(3)
  expect(metrics).toMatchObject({ ready: false, errors: 3 })
  if (failure !== 'dispatch') expect(f.broadcaster.handle).toHaveBeenCalledTimes(3)
})

it('keeps reconciliation single-flight while delivery is failing', async () => {
  const f = fixture()
  let finish!: () => void
  f.broadcaster.reconcile.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  f.waku.dispatch.mockRejectedValue(new Error('Waku unavailable'))
  f.advance.mockImplementation(async iteration => { await vi.advanceTimersByTimeAsync(31_000); if (iteration === 3) finish() })
  await runLoop(f)
  expect(f.broadcaster.reconcile).toHaveBeenCalledOnce()
  expect(f.waku.dispatch).toHaveBeenCalledTimes(3)
})

it('restores normal polling after Waku recovers even if refresh still fails', async () => {
  const f = fixture()
  f.stopAfter = 5
  f.sdk.balances.mockRejectedValue(new Error('Read node unavailable'))
  for (let i = 0; i < 4; i++) f.waku.dispatch.mockRejectedValueOnce(new Error('Waku unavailable'))
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  const metrics = await runLoop(f)
  expect(f.advance.mock.calls.map(([, milliseconds]) => milliseconds)).toEqual([2000, 4000, 8000, 16_000, 1000])
  expect(f.sdk.balances).toHaveBeenCalledTimes(2)
  expect(metrics).toMatchObject({ ready: false, errors: 6 })
})

it('clears saturation while successful fee publications take six seconds', async () => {
  const f = fixture()
  f.stopAfter = 70
  const polls: number[] = []
  let activePosts = 0, maximumPosts = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: URL, options: RequestInit) => {
    if (options.method === 'POST') {
      maximumPosts = Math.max(maximumPosts, ++activePosts)
      await new Promise(resolve => setTimeout(resolve, 6000))
      activePosts--
      return new Response('')
    }
    polls.push(performance.now())
    return new Response(JSON.stringify(polls.length === 1 ? Array(16).fill(null) : []))
  }))
  const relay = new WakuRelay('http://127.0.0.1:8645')
  f.waku.publish.mockImplementation(() => relay.publish('fees', new Uint8Array()))
  f.waku.dispatch.mockImplementation(handle => relay.dispatch(handle, new AbortController().signal))
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  await runLoop(f)
  expect(polls).toHaveLength(70)
  expect(polls.slice(1).every((time, i) => time - polls[i] === 1000)).toBe(true)
  expect(f.waku.publish).toHaveBeenCalledTimes(3)
  expect(maximumPosts).toBe(1)
  expect(relay.fullBatches).toBe(1)
  expect(relay.saturated).toBe(false)
})

it('keeps refresh single-flight while a dependency remains pending', async () => {
  const f = fixture()
  let finish!: () => void
  f.sdk.balances.mockImplementation(() => new Promise(resolve => { finish = () => resolve({}) }))
  f.advance.mockImplementation(async iteration => { await vi.advanceTimersByTimeAsync(31_000); if (iteration === 3) finish() })
  await runLoop(f)
  expect(f.sdk.balances).toHaveBeenCalledOnce()
  expect(f.broadcaster.reconcile).toHaveBeenCalledTimes(3)
  expect(f.waku.dispatch).toHaveBeenCalledTimes(3)
})

it('starts the next due refresh as soon as a slow refresh finishes', async () => {
  const f = fixture()
  f.stopAfter = 40
  const samples: number[] = []
  f.sdk.balances.mockImplementation(async () => { samples.push(performance.now()); return {} })
  f.broadcaster.feeAdvertisement.mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 35_000))
    return { available: true, message: new Uint8Array() }
  })
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  await runLoop(f)
  expect(samples).toEqual([0, 35_000])
  expect(f.broadcaster.reconcile).toHaveBeenCalledTimes(2)
})

it('keeps cached readiness during a slow routine refresh and restores it after delivery recovers', async () => {
  const f = fixture()
  f.stopAfter = 40
  f.waku.publish.mockImplementationOnce(async () => {})
    .mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 6000)) })
  f.waku.dispatch.mockImplementationOnce(async () => {})
    .mockRejectedValueOnce(new Error('Temporary Waku failure'))
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  const metrics = await runLoop(f)
  expect(f.observed[1].ready).toBe(false)
  expect(f.observed.slice(2).every(sample => sample.ready)).toBe(true)
  expect(metrics).toMatchObject({ ready: true, errors: 1 })
})

it.each(['failed', 'unavailable'])('does not restore readiness from a %s fee refresh', async (failure) => {
  const f = fixture()
  f.stopAfter = 36
  f.broadcaster.feeAdvertisement.mockResolvedValueOnce({ available: true, message: new Uint8Array() })
  if (failure === 'failed') f.broadcaster.feeAdvertisement.mockRejectedValue(new Error('Unavailable fees'))
  else f.broadcaster.feeAdvertisement.mockResolvedValue({ available: false, message: new Uint8Array() })
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  const metrics = await runLoop(f)
  expect(f.observed[2].ready).toBe(true)
  expect(f.observed.slice(31).every(sample => !sample.ready)).toBe(true)
  expect(metrics.ready).toBe(false)
})

it('expires cached readiness at the existing quote lifetime if refresh remains pending', async () => {
  const f = fixture()
  f.stopAfter = 305
  let finish!: () => void
  f.sdk.balances.mockResolvedValueOnce({}).mockImplementation(() => new Promise(resolve => { finish = () => resolve({}) }))
  f.advance.mockImplementation(async (iteration, milliseconds) => {
    await vi.advanceTimersByTimeAsync(milliseconds)
    if (iteration === 150) vi.setSystemTime(Date.now() - 60_000)
    if (iteration === f.stopAfter) finish()
  })
  await runLoop(f)
  expect(f.observed[299].ready).toBe(true)
  expect(f.observed.slice(300).every(sample => !sample.ready)).toBe(true)
  expect(f.sdk.balances).toHaveBeenCalledTimes(2)
})

it('expires readiness in the actual health response even if dispatch cannot advance the loop', () => {
  vi.useFakeTimers()
  expect(health).toHaveLength(1)
  const handlerSource = ts.transpileModule(`(${health[0].getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const handle = new Function('metrics', `
    const command = 'run', identity = {}, config = {}, sdk = { ready: () => true }, waku = undefined;
    const store = { pending: () => [] };
    return ${handlerSource}
  `)({ ready: true, feeReadyUntil: 1000 })
  let body: { ready: boolean }
  const response = { setHeader: () => {}, end: (json: string) => { body = JSON.parse(json) } }
  handle({ url: '/health' }, response)
  expect(body!.ready).toBe(true)
  vi.advanceTimersByTime(1000)
  handle({ url: '/health' }, response)
  expect(body!.ready).toBe(false)
})
