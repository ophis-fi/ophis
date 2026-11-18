import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'

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
  const { broadcaster, sdk, waku, advance } = fixture;
  const config = { state: '/unused' }, command = 'run', abort = new AbortController();
  const TOPICS = { fees: 'fees' }, assertDisk = () => {};
  const metrics = { ready: false, errors: 0 };
  let stopping = false, lastRefresh = 0, failures = 0, syncReported = false, reconcile;
  let iterations = 0;
  const delay = async () => { await advance(++iterations); stopping = iterations === 3; };
  ${loop}
  await reconcile;
  return metrics;
`) as (input: ReturnType<typeof fixture>) => Promise<{ ready: boolean; errors: number }>

afterEach(() => vi.useRealTimers())

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
  return { broadcaster, sdk, waku, advance: vi.fn(async (_iteration: number) => { vi.setSystemTime(Date.now() + 31_000) }) }
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
