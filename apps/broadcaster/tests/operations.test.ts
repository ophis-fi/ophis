import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { accountingReport, acknowledgeLoss, monitor, monitorMetrics } from '../src/operations'
import { Store } from '../src/storage'
import { CHAIN_ID, TOKENS } from '../src/config'
import { config } from './request.fixture'

const mocks = vi.hoisted(() => ({ disk: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), statfsSync: mocks.disk }))
let path: string, store: Store
const operatorAddress = '0x0000000000000000000000000000000000001234'
const blockHash = `0x${'aa'.repeat(32)}`
beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), 'ophis-operations-')); store = new Store(path)
  mocks.disk.mockReset().mockReturnValue({ bavail: 8 * 1024 ** 3, bsize: 1 })
})
afterEach(() => {
  store.close(); rmSync(path, { recursive: true, force: true })
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules()
})

async function fixture(chainId = CHAIN_ID, acknowledge = acknowledgeLoss) {
  const wallet = Wallet.createRandom()
  const raw = await wallet.signTransaction({ to: wallet.address, chainId, nonce: 0, type: 2,
    gasLimit: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, value: 0n })
  const hash = Transaction.from(raw).hash!
  store.signed('loss', 'encrypted-envelope', raw, hash, 42_000n, config.dailyBudget, 0, '{}', 0, true)
  store.confirmed('loss', 21_000n, Date.now())
  const receipt = { hash, from: wallet.address, status: 0, blockNumber: 80, blockHash: `0x${'aa'.repeat(32)}`,
    gasUsed: 21_000n, gasPrice: 1n, blobGasUsed: null }
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: BigInt(chainId) })),
    getBlock: vi.fn(async (tag: string | number) => ({ number: tag === 'latest' ? 100 : tag === 'finalized' ? 90 : Number(tag),
      timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: chainId === 56 ? 0n : 1n, hash: receipt.blockHash })),
    getFeeData: vi.fn(async () => ({ gasPrice: 1n })),
    getTransactionReceipt: vi.fn(async () => receipt), getTransactionCount: vi.fn(async () => 1),
    getCode: vi.fn(async () => '0x'),
  }
  const settings = { ...config, chainId, operatorAddress: wallet.address, state: path }
  const run = (reason = 'Investigated finalized outer revert') => acknowledge('loss', reason, settings, store, provider as unknown as JsonRpcProvider)
  return { wallet, raw, hash, receipt, provider, settings, run }
}

async function selectedMonitor(chainId: number) {
  vi.resetModules(); vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const operations = await import('../src/operations')
  const { TOKENS: tokens } = await import('../src/config')
  const settings = { ...config, chainId, operatorAddress, state: path }
  const health = { chainId, operatorAddress, ready: true, locked: false, synchronized: true,
    pending: 0, feeAssurancePending: 0, errors: 0, wakuSaturated: false }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health))))
  const provider = {
    getBlock: vi.fn(async (tag: string) => ({ number: tag === 'finalized' ? 90 : 100, hash: blockHash,
      timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: chainId === 56 ? 0n : 1n })),
    getFeeData: vi.fn(async () => ({ gasPrice: 50_000_000n as bigint | null })),
    getBalance: vi.fn(async () => settings.reserve + settings.maxTransactionCost),
    send: vi.fn(async () => `0x${chainId.toString(16)}`),
  }
  const oracle = { rates: async () => Object.fromEntries(tokens.map((token) => [getAddress(token.address), 1n])) }
  const run = () => operations.monitor(settings, provider as unknown as JsonRpcProvider, oracle, 4340)
  return { operations, settings, health, provider, run }
}

it('acknowledges a finalized failure without changing the signed request, fee flag, gas expense or pilot marker', async () => {
  const f = await fixture()
  const before = store.get('loss'), exposure = store.exposure()
  const pilot = store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')
  await f.run()
  expect(store.get('loss')).toEqual(before)
  expect(store.get('loss')?.assured).toBe(0)
  expect(store.exposure()).toBe(exposure)
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')).toEqual(pilot)
  expect(store.pending()).toEqual([]); expect(store.hasPending()).toBe(false)
  expect(store.nonceBlocked(0)).toBe(true)
  expect(store.nonceBlocked(1)).toBe(false)
  for (const sql of ['UPDATE settlement_resolutions SET reason=\'changed\'', 'DELETE FROM settlement_resolutions'])
    expect(() => store.db.exec(sql)).toThrow('append-only')
  await expect(f.run()).rejects.toThrow()
  store.signed('next', 'encrypted', 'signed-next', 'next-hash', 100n, config.dailyBudget, 1)
  expect(store.hasPending()).toBe(true)
  expect(store.pending().map((row) => row.key)).toEqual(['next'])
  store.close(); store = new Store(path)
  expect(store.get('loss')).toEqual(before)
  expect(accountingReport(store.db).acknowledgedLossWei).toBe('21000')
})

it.each(['missing', 'success', 'unconfirmed', 'assured', 'cost', 'hash', 'from', 'nonce', 'chain', 'unfinalized',
  'reorg', 'stale', 'delegated', 'cancellation', 'reason', 'settings-chain', 'malformed-finality'])('refuses %s loss resolution without writing an override', async (reason) => {
  const f = await fixture()
  if (reason === 'missing') f.provider.getTransactionReceipt.mockResolvedValue(null as unknown as typeof f.receipt)
  if (reason === 'success') f.receipt.status = 1
  if (reason === 'unconfirmed') store.db.prepare('UPDATE requests SET confirmed=0').run()
  if (reason === 'assured') store.assured('loss', true)
  if (reason === 'cost') f.receipt.gasPrice = 2n
  if (reason === 'hash') f.receipt.hash = `0x${'bb'.repeat(32)}`
  if (reason === 'from') f.receipt.from = Wallet.createRandom().address
  if (reason === 'nonce') f.provider.getTransactionCount.mockResolvedValue(2)
  if (reason === 'chain') f.provider.getNetwork.mockResolvedValue({ chainId: 56n })
  if (reason === 'unfinalized') f.receipt.blockNumber = 91
  if (reason === 'reorg') f.provider.getBlock.mockImplementation(async (tag) => ({ number: tag === 'latest' ? 100 : 90,
    timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n, hash: `0x${'cc'.repeat(32)}` }))
  if (reason === 'stale') f.provider.getBlock.mockResolvedValue({ number: 100, timestamp: 0, baseFeePerGas: 1n, hash: f.receipt.blockHash })
  if (reason === 'delegated') f.provider.getCode.mockResolvedValue('0xef0100')
  if (reason === 'cancellation') store.db.prepare('UPDATE requests SET cancel_hash=?').run('cancel-hash')
  if (reason === 'settings-chain') f.settings.chainId = 56
  if (reason === 'malformed-finality') f.provider.getBlock.mockImplementation(async (tag) => ({
    number: tag === 'latest' ? 100 : tag === 'finalized' ? NaN : Number(tag),
    timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n, hash: f.receipt.blockHash }))
  const before = store.get('loss')
  await expect(f.run(reason === 'reason' ? 'bad\nreason' : undefined)).rejects.toThrow()
  expect(store.db.prepare('SELECT * FROM settlement_resolutions').all()).toEqual([])
  expect(store.get('loss')).toEqual(before)
})

it('ties the override to the exact confirmed hash and cost, even after reopen', async () => {
  const f = await fixture(); await f.run()
  store.close(); store = new Store(path)
  expect(store.hasPending()).toBe(false)
  store.db.prepare('UPDATE requests SET actual_cost=?').run('21001')
  expect(store.hasPending()).toBe(true); expect(store.pending()).toHaveLength(1)
  store.db.prepare('UPDATE requests SET actual_cost=?,hash=?').run('21000', 'changed-hash')
  expect(store.hasPending()).toBe(true)
})

it.each([56, 137, 42161])('acknowledges only a finalized canonical loss on selected chain %i', async (chainId) => {
  vi.resetModules(); vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const operations = await import('../src/operations')
  const f = await fixture(chainId, operations.acknowledgeLoss)
  f.receipt.blockNumber = 91
  await expect(f.run()).rejects.toThrow('finalized reverted transaction')
  expect(store.db.prepare('SELECT * FROM settlement_resolutions').all()).toEqual([])
  f.receipt.blockNumber = 80
  await f.run()
  expect(store.db.prepare('SELECT hash,actual_cost,block_number,block_hash FROM settlement_resolutions').get())
    .toEqual({ hash: f.hash, actual_cost: '21000', block_number: 80, block_hash: f.receipt.blockHash })
  expect(f.provider.getBlock).toHaveBeenCalledWith('finalized')
})

it('does not let twenty resolved losses hide an unresolved request behind the reconciliation limit', () => {
  for (let i = 0; i < 21; i++) {
    store.signed(String(i), 'encrypted', 'raw', `hash-${i}`, 100n, 10_000n, i)
    store.confirmed(String(i), 80n, Date.now())
    store.acknowledgeLoss(String(i), `hash-${i}`, 80n, 100, 'block-hash', 'Test finalized gas loss')
  }
  store.signed('pending', 'encrypted', 'raw', 'pending-hash', 100n, 10_000n, 21)
  expect(store.pending().map((row) => row.key)).toEqual(['pending'])
  expect(store.hasPending()).toBe(true)
})

it('accounts only for authenticated received fees and reports historical gaps, cancellations and gas losses separately', async () => {
  const f = await fixture(); await f.run()
  const proof = JSON.stringify({ payment: { token: TOKENS[0].address, amount: '9007199254740993' } })
  for (const [index, key] of ['paid', 'cancelled', 'historical'].entries()) {
    store.signed(key, 'DO-NOT-EXPORT-ENVELOPE', 'DO-NOT-EXPORT-RAW', `${key}-hash`, 100n, config.dailyBudget, index + 1, proof)
    store.confirmed(key, 80n, Date.now())
    store.assured(key, key === 'paid')
  }
  store.db.prepare('UPDATE requests SET fee_data=? WHERE key=?').run('{}', 'historical')
  store.signed('pending', 'encrypted', 'signed bytes', 'pending-hash', 200n, config.dailyBudget, 4)
  expect(accountingReport(store.db)).toEqual({ requests: 5, recordedGasExpenseWei: '21240', unresolvedMaximumWei: '200',
    acknowledgedLossWei: '21000', acknowledgedLosses: 1, historicalSettlementsWithoutFeeAmounts: 1,
    receivedFees: { [getAddress(TOKENS[0].address)]: '9007199254740993' } })
  expect(JSON.stringify(accountingReport(store.db))).not.toContain('DO-NOT-EXPORT')
})

it.each(['healthy', 'low-reserve', 'pending', 'fee', 'pricing', 'stale', 'offline', 'disk', 'chain', 'rpc-down',
  'wrong-service-chain', 'wrong-service-operator', 'waku'])('reports the %s operator condition without signing or logging upstream errors', async (condition) => {
  const health = { chainId: CHAIN_ID, operatorAddress, ready: true, locked: false, synchronized: true,
    pending: 0, feeAssurancePending: 0, errors: 0, wakuSaturated: false }
  if (condition === 'pending') health.pending = 1
  if (condition === 'fee') health.feeAssurancePending = 1
  if (condition === 'wrong-service-chain') health.chainId = 56
  if (condition === 'wrong-service-operator') health.operatorAddress = Wallet.createRandom().address
  if (condition === 'waku') health.wakuSaturated = true
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (condition === 'offline') throw new Error('upstream-credential-must-not-leak')
    return new Response(JSON.stringify(health))
  }))
  const provider = {
    getBlock: async () => {
      if (condition === 'rpc-down') throw new Error('upstream-credential-must-not-leak')
      return { number: 100, hash: blockHash, timestamp: condition === 'stale' ? 0 : Math.floor(Date.now() / 1000), baseFeePerGas: 1n }
    },
    send: async () => condition === 'chain' ? '0x38' : '0x1',
    getBalance: async () => condition === 'low-reserve' ? 0n : config.reserve + config.maxTransactionCost,
  }
  const oracle = { rates: async () => {
    if (condition === 'pricing') throw new Error('upstream-credential-must-not-leak')
    return Object.fromEntries(TOKENS.map((token) => [getAddress(token.address), 1n]))
  } }
  if (condition === 'disk') mocks.disk.mockReturnValue({ bavail: 1, bsize: 1 })
  const result = await monitor({ ...config, state: path, operatorAddress }, provider as unknown as JsonRpcProvider, oracle, 4340)
  const expected = { 'low-reserve': 'low-gas-reserve', pending: 'pending-nonce', fee: 'missing-fee-assurance',
    pricing: 'stale-fee-pricing', stale: 'stale-read-node', offline: 'health-unreachable', disk: 'low-disk',
    chain: 'wrong-read-network', 'rpc-down': 'stale-read-node', 'wrong-service-chain': 'wrong-service-instance',
    'wrong-service-operator': 'wrong-service-instance', waku: 'waku-saturated' }[condition]
  expect(result.ok).toBe(condition === 'healthy')
  if (expected) expect(result.alerts).toContain(expected)
  expect(JSON.stringify(result)).not.toContain('upstream-credential')
  expect(monitorMetrics(result)).toContain(`ophis_broadcaster_monitor_ok{chain_id="${CHAIN_ID}"} ${result.ok ? 1 : 0}`)
  expect(monitorMetrics(result).trim().split('\n').every((line) => line.includes(`chain_id="${CHAIN_ID}"`))).toBe(true)
  if (expected) expect(monitorMetrics(result)).toContain(`reason="${expected}"`)
  expect(monitorMetrics(result)).not.toContain('gasBalance')
})

it('rejects metric-label injection and excludes private fee balances from monitor output', async () => {
  expect(() => monitorMetrics({ ok: false, alerts: ['invalid"\nmetric 1'] })).toThrow('Invalid monitor label')
  const health = { chainId: CHAIN_ID, operatorAddress, ready: true, locked: false, synchronized: true,
    pending: 0, feeAssurancePending: 0, errors: 0, wakuSaturated: false,
    feeBalances: { privateFeeAmount: 'do-not-export' } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health))))
  const provider = { getBlock: async () => ({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }), send: async () => '0x1',
    getBalance: async () => config.reserve + config.maxTransactionCost }
  const result = await monitor({ ...config, state: path, operatorAddress }, provider as unknown as JsonRpcProvider,
    { rates: async () => Object.fromEntries(TOKENS.map((token) => [getAddress(token.address), 1n])) }, 4340)
  expect(JSON.stringify(result)).not.toContain('do-not-export')
  expect(result.ok).toBe(true)
})

it.each([56, 137, 42161])('monitors chain %i with its own identity, settlement state and metric labels', async (chainId) => {
  const f = await selectedMonitor(chainId)
  const result = await f.run()
  expect(result.ok).toBe(true)
  expect(result.health).toMatchObject({ chainId, operatorAddress, wakuSaturated: false })
  expect(f.provider.getBlock).toHaveBeenCalledWith('finalized')
  expect(f.operations.monitorMetrics(result).trim().split('\n').every((line) => line.includes(`chain_id="${chainId}"`))).toBe(true)
  expect(f.provider.getFeeData).toHaveBeenCalledTimes(chainId === 56 ? 1 : 0)
})

it.each(['gas cap', 'missing minimum', 'missing finality', 'wrong network'])(
  'fails closed for BNB %s while permitting its zero base fee', async (condition) => {
    const f = await selectedMonitor(56)
    if (condition === 'gas cap') f.provider.getFeeData.mockResolvedValue({ gasPrice: config.maxGasPrice + 1n })
    if (condition === 'missing minimum') f.provider.getFeeData.mockResolvedValue({ gasPrice: null })
    if (condition === 'missing finality') f.provider.getBlock.mockImplementation(async (tag) => ({
      number: tag === 'finalized' ? 101 : 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 0n }))
    if (condition === 'wrong network') f.provider.send.mockResolvedValue('0x89')
    const result = await f.run()
    expect(result.ok).toBe(false)
    expect(result.alerts).toEqual([condition === 'gas cap' ? 'gas-price-cap'
      : condition === 'wrong network' ? 'wrong-read-network' : 'stale-read-node'])
  },
)

it('rejects mismatched monitor settings before reading another instance', async () => {
  const f = await selectedMonitor(56)
  f.settings.chainId = 137
  await expect(f.run()).rejects.toThrow('settings must match')
  expect(fetch).not.toHaveBeenCalled()
  expect(f.provider.getBlock).not.toHaveBeenCalled()
})

it('does not export malformed health values as diagnostics', async () => {
  const f = await selectedMonitor(56)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...f.health,
    errors: 'upstream-credential-must-not-leak' }))))
  const result = await f.run()
  expect(result.alerts).toEqual(['invalid-health'])
  expect(result.health).toBeUndefined()
  expect(JSON.stringify(result)).not.toContain('upstream-credential')
})

it('reports a bounded node timeout even when a JSON-RPC initialization never settles', async () => {
  vi.useFakeTimers()
  try {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ chainId: CHAIN_ID, operatorAddress, ready: true, locked: false,
      synchronized: true, pending: 0, feeAssurancePending: 0, errors: 0, wakuSaturated: false }))))
    const provider = { getBlock: () => new Promise(() => {}), send: async () => '0x1',
      getBalance: async () => config.reserve + config.maxTransactionCost }
    const pending = monitor({ ...config, state: path, operatorAddress }, provider as unknown as JsonRpcProvider,
      { rates: async () => Object.fromEntries(TOKENS.map((token) => [getAddress(token.address), 1n])) }, 4340)
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending).alerts).toEqual(['stale-read-node'])
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('bounds BNB minimum-gas RPC reads by the same fifteen-second monitor deadline', async () => {
  const f = await selectedMonitor(56)
  vi.useFakeTimers()
  try {
    f.provider.getFeeData.mockImplementation(() => new Promise(() => {}))
    const pending = f.run()
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pending).alerts).toEqual(['stale-read-node'])
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

it('publishes healthy and alert textfiles atomically and retains the last sample after an invocation failure', () => {
  writeFileSync(join(path, 'compose.env'), '', { mode: 0o600 })
  const hooks = join(path, 'shell-test-hooks')
  writeFileSync(hooks, 'docker() { printf "%s" "$OPHIS_TEST_MONITOR_TEXT"; return "$OPHIS_TEST_MONITOR_EXIT"; }\ntimeout() { shift; "$@"; }\nflock() { return 0; }\n', { mode: 0o600 })
  const output = join(path, 'broadcaster.prom')
  for (const status of [0, 2, 1]) {
    const previous = status === 0 ? '' : readFileSync(output, 'utf8')
    const text = `ophis_broadcaster_monitor_ok{chain_id="${CHAIN_ID}"} ${status === 0 ? 1 : 0}\n`
    const result = spawnSync('/bin/bash', [new URL('../scripts/monitor.sh', import.meta.url).pathname, path, output],
      { timeout: 3000, env: { ...process.env, BASH_ENV: hooks,
        OPHIS_TEST_MONITOR_TEXT: text, OPHIS_TEST_MONITOR_EXIT: String(status) } })
    expect(result.status).toBe(status)
    expect(readFileSync(output, 'utf8')).toBe(status === 1 ? previous : text)
    expect(readdirSync(path).some((name) => name.startsWith('.ophis-broadcaster.'))).toBe(false)
  }
})
