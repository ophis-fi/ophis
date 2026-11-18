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
const block = loops[0].parent as ts.Block
const first = block.statements.findIndex(node => ts.isVariableStatement(node) && node.getText(source).startsWith('let lastRefresh'))
if (first < 0 || !ts.isTryStatement(block.parent) || !block.parent.finallyBlock) throw new Error('Expected service scheduling and cleanup.')
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const service = compile(block.statements.slice(first, block.statements.indexOf(loops[0]) + 1).map(node => node.getText(source)).join('\n'))
const cleanup = compile(block.parent.finallyBlock.getText(source))
if (health.length !== 1) throw new Error('Expected exactly one health handler.')
const healthSource = compile(`(${health[0].getText(source)})`)
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const runLoop = new AsyncFunction('fixture', `
  const { broadcaster, sdk, waku, advance, stopAfter, provider, store } = fixture;
  const config = { state: '/unused' }, command = 'run', abort = new AbortController();
  const TOPICS = { fees: 'fees' }, FEE_LIFETIME_MS = 5 * 60000, assertDisk = () => {};
  const metrics = { ready: false, deliveryReady: false, feeReadyUntil: 0, feeExpiresAt: 0, errors: 0 };
  let stopping = false, reconcile, refresh, maintenance;
  const stop = () => { stopping = true; abort.abort(); };
  const process = { off: () => {} }, identity = {}, server = undefined, sender = undefined, lock = undefined;
  const healthHandler = ${healthSource}
  const readHealth = () => {
    let result;
    healthHandler({ url: '/health' }, { setHeader: () => {}, end: value => { result = JSON.parse(value); } });
    return result;
  };
  fixture.readHealth = readHealth; fixture.stop = stop;
  let iterations = 0;
  const delay = async (milliseconds) => {
    fixture.observed.push(readHealth());
    if (++iterations === stopAfter) stop();
    await advance(iterations, milliseconds);
  };
  try { ${service} } finally ${cleanup}
  return readHealth();
`) as (input: ReturnType<typeof fixture>) => Promise<{ ready: boolean; errors: number }>

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

function fixture() {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-18T12:00:00Z'))
  const broadcaster = {
    reconcile: vi.fn(async () => {}),
    feeAdvertisement: vi.fn(async () => advertisement()),
    handle: vi.fn(async (_payload: Uint8Array) => undefined),
  }
  const sdk = { ready: () => true, balances: vi.fn(async () => ({})), stop: vi.fn(async () => {}) }
  const provider = { destroy: vi.fn() }, store = { pending: () => [], close: vi.fn() }
  const waku = {
    publish: vi.fn(async () => {}),
    dispatch: vi.fn(async (handle: typeof broadcaster.handle) => { await handle(new Uint8Array()) }),
  }
  return { broadcaster, sdk, waku, provider, store, stopAfter: 3, observed: [] as { ready: boolean; errors: number }[],
    readHealth: undefined as (() => { ready: boolean; errors: number }) | undefined, stop: undefined as (() => void) | undefined,
    advance: vi.fn(async (_iteration: number, _milliseconds: number) => {
    await vi.advanceTimersByTimeAsync(31_000)
  }) }
}

function advertisement(available = true) {
  return { available, expiration: Date.now() + 300_000, message: new Uint8Array() }
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
    return advertisement()
  })
  f.advance.mockImplementation(async (_iteration, milliseconds) => { await vi.advanceTimersByTimeAsync(milliseconds) })
  await runLoop(f)
  expect(samples).toHaveLength(2)
  expect(samples[0]).toBe(0)
  expect(samples[1]).toBeGreaterThanOrEqual(35_000)
  expect(samples[1]).toBeLessThanOrEqual(36_000)
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
  f.broadcaster.feeAdvertisement.mockResolvedValueOnce(advertisement())
  if (failure === 'failed') f.broadcaster.feeAdvertisement.mockRejectedValue(new Error('Unavailable fees'))
  else f.broadcaster.feeAdvertisement.mockResolvedValue(advertisement(false))
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

it.each(['monotonic', 'signed'] as const)('enforces the %s expiration in health even if dispatch cannot advance the loop', (clock) => {
  vi.useFakeTimers()
  expect(health).toHaveLength(1)
  const handle = new Function('metrics', `
    const command = 'run', identity = {}, config = {}, sdk = { ready: () => true }, waku = undefined;
    const store = { pending: () => [] };
    return ${healthSource}
  `)({ deliveryReady: true, feeReadyUntil: 1000, feeExpiresAt: Date.now() + 1000 })
  let body: { ready: boolean }
  const response = { setHeader: () => {}, end: (json: string) => { body = JSON.parse(json) } }
  handle({ url: '/health' }, response)
  expect(body!.ready).toBe(true)
  if (clock === 'monotonic') vi.advanceTimersByTime(1000)
  else vi.setSystemTime(Date.now() + 1000)
  handle({ url: '/health' }, response)
  expect(body!.ready).toBe(false)
})

it('runs due maintenance while a 64-second delivery batch is still draining', async () => {
  const f = fixture()
  f.stopAfter = 1
  const reconciled: number[] = []
  f.broadcaster.reconcile.mockImplementation(async () => { reconciled.push(performance.now()) })
  f.waku.dispatch.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 64_000)) })
  f.advance.mockResolvedValue(undefined)
  const run = runLoop(f)
  await vi.advanceTimersByTimeAsync(64_000)
  await run
  expect(reconciled).toEqual([0, 30_000, 60_000])
  expect(f.sdk.balances).toHaveBeenCalledTimes(3)
  expect(f.waku.dispatch).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('reflects a successful fee publication while the next dispatch is still pending', async () => {
  const f = fixture()
  f.stopAfter = 2
  f.waku.publish.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 2000)) })
  f.waku.dispatch.mockResolvedValueOnce(undefined)
    .mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 10_000)) })
  f.advance.mockResolvedValue(undefined)
  const run = runLoop(f)
  await vi.advanceTimersByTimeAsync(0)
  expect(f.readHealth!().ready).toBe(false)
  await vi.advanceTimersByTimeAsync(2000)
  expect(f.readHealth!().ready).toBe(true)
  expect(f.waku.dispatch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(8000)
  await run
})

it('stops scheduling on shutdown and drains all active work before closing resources', async () => {
  const f = fixture()
  f.stopAfter = 1
  let finishDelivery!: () => void, finishRefresh!: () => void, finishReconcile!: () => void
  f.waku.dispatch.mockImplementation(() => new Promise(resolve => { finishDelivery = resolve }))
  f.sdk.balances.mockImplementation(() => new Promise(resolve => { finishRefresh = () => resolve({}) }))
  f.broadcaster.reconcile.mockImplementation(() => new Promise(resolve => { finishReconcile = resolve }))
  f.advance.mockResolvedValue(undefined)
  const run = runLoop(f)
  f.stop!()
  await vi.advanceTimersByTimeAsync(64_000)
  expect(f.sdk.balances).toHaveBeenCalledOnce()
  expect(f.broadcaster.reconcile).toHaveBeenCalledOnce()
  finishDelivery()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.sdk.stop).not.toHaveBeenCalled()
  finishRefresh()
  await vi.advanceTimersByTimeAsync(0)
  expect(f.store.close).not.toHaveBeenCalled()
  expect(f.waku.publish).not.toHaveBeenCalled()
  finishReconcile()
  await run
  expect(f.sdk.stop).toHaveBeenCalledOnce()
  expect(f.provider.destroy).toHaveBeenCalledOnce()
  expect(f.store.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})
