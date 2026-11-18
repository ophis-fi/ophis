import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { WakuRelay } from '../src/waku'

// Execute the actual loop with fake I/O; importing main would start custody and SDK initialization.
const source = ts.createSourceFile('main.ts', readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const loops: ts.WhileStatement[] = []
function visit(node: ts.Node): void {
  if (ts.isWhileStatement(node) && node.getText(source).includes('waku!.dispatch(')) loops.push(node)
  ts.forEachChild(node, visit)
}
visit(source)
if (loops.length !== 1) throw new Error('Expected exactly one broadcaster dispatch loop.')
const loop = ts.transpileModule(loops[0].getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const runLoop = new AsyncFunction('fixture', `
  const { broadcaster, sdk, waku, advance, stopAfter } = fixture;
  const config = { state: '/unused' }, command = 'run', abort = new AbortController();
  const TOPICS = { fees: 'fees' }, assertDisk = () => {};
  const metrics = { ready: false, errors: 0 };
  let stopping = false, lastRefresh = 0, failures = 0, syncReported = false, reconcile, refresh;
  let iterations = 0;
  const delay = async (milliseconds) => { await advance(++iterations, milliseconds); stopping = iterations === stopAfter; };
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
  return { broadcaster, sdk, waku, stopAfter: 3, advance: vi.fn(async (_iteration: number, _milliseconds: number) => {
    vi.setSystemTime(Date.now() + 31_000)
    await vi.advanceTimersByTimeAsync(0)
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
  f.advance.mockImplementation(async iteration => { vi.setSystemTime(Date.now() + 31_000); if (iteration === 3) finish() })
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
  f.advance.mockImplementation(async iteration => { vi.setSystemTime(Date.now() + 31_000); if (iteration === 3) finish() })
  await runLoop(f)
  expect(f.sdk.balances).toHaveBeenCalledOnce()
  expect(f.broadcaster.reconcile).toHaveBeenCalledTimes(3)
  expect(f.waku.dispatch).toHaveBeenCalledTimes(3)
})
