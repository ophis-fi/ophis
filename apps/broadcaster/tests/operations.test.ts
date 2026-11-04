import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { accountingReport, acknowledgeLoss, monitor, monitorMetrics } from '../src/operations'
import { Store } from '../src/storage'
import { TOKENS } from '../src/config'
import { config } from './request.fixture'

const mocks = vi.hoisted(() => ({ disk: vi.fn() }))
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), statfsSync: mocks.disk }))
let path: string, store: Store
beforeEach(() => {
  path = mkdtempSync(join(tmpdir(), 'ophis-operations-')); store = new Store(path)
  mocks.disk.mockReset().mockReturnValue({ bavail: 8 * 1024 ** 3, bsize: 1 })
})
afterEach(() => { store.close(); rmSync(path, { recursive: true, force: true }); vi.unstubAllGlobals() })

async function fixture() {
  const wallet = Wallet.createRandom()
  const raw = await wallet.signTransaction({ to: wallet.address, chainId: 1, nonce: 0, type: 2,
    gasLimit: 21_000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, value: 0n })
  const hash = Transaction.from(raw).hash!
  store.signed('loss', 'encrypted-envelope', raw, hash, 42_000n, config.dailyBudget, 0, '{}', 0, true)
  store.confirmed('loss', 21_000n, Date.now())
  const receipt = { hash, from: wallet.address, status: 0, blockNumber: 80, blockHash: `0x${'aa'.repeat(32)}`,
    gasUsed: 21_000n, gasPrice: 1n, blobGasUsed: null }
  const provider = {
    getNetwork: vi.fn(async () => ({ chainId: 1n })),
    getBlock: vi.fn(async (tag: string | number) => ({ number: tag === 'latest' ? 100 : tag === 'finalized' ? 90 : Number(tag),
      timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n, hash: receipt.blockHash })),
    getTransactionReceipt: vi.fn(async () => receipt), getTransactionCount: vi.fn(async () => 1),
    getCode: vi.fn(async () => '0x'),
  }
  const settings = { ...config, operatorAddress: wallet.address, state: path }
  const run = (reason = 'Investigated finalized outer revert') => acknowledgeLoss('loss', reason, settings, store, provider as unknown as JsonRpcProvider)
  return { wallet, raw, hash, receipt, provider, settings, run }
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
  expect(store.nonceBlocked(0)).toBe(false)
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
  'reorg', 'stale', 'delegated', 'cancellation', 'reason'])('refuses %s loss resolution without writing an override', async (reason) => {
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
  for (const key of ['paid', 'cancelled', 'historical']) {
    store.signed(key, 'DO-NOT-EXPORT-ENVELOPE', 'DO-NOT-EXPORT-RAW', `${key}-hash`, 100n, config.dailyBudget, 1, proof)
    store.confirmed(key, 80n, Date.now())
    store.assured(key, key === 'paid')
  }
  store.db.prepare('UPDATE requests SET fee_data=? WHERE key=?').run('{}', 'historical')
  store.signed('pending', 'encrypted', 'signed bytes', 'pending-hash', 200n, config.dailyBudget, 2)
  expect(accountingReport(store.db)).toEqual({ requests: 5, recordedGasExpenseWei: '21240', unresolvedMaximumWei: '200',
    acknowledgedLossWei: '21000', acknowledgedLosses: 1, historicalSettlementsWithoutFeeAmounts: 1,
    receivedFees: { [getAddress(TOKENS[0].address)]: '9007199254740993' } })
  expect(JSON.stringify(accountingReport(store.db))).not.toContain('DO-NOT-EXPORT')
})

it.each(['healthy', 'low-reserve', 'pending', 'fee', 'pricing', 'stale', 'offline', 'disk'])('reports the %s operator condition without signing or logging upstream errors', async (condition) => {
  const health = { ready: true, locked: false, synchronized: true, pending: 0, feeAssurancePending: 0, errors: 0 }
  if (condition === 'pending') health.pending = 1
  if (condition === 'fee') health.feeAssurancePending = 1
  vi.stubGlobal('fetch', vi.fn(async () => {
    if (condition === 'offline') throw new Error('upstream-credential-must-not-leak')
    return new Response(JSON.stringify(health))
  }))
  const provider = {
    getBlock: async () => ({ timestamp: condition === 'stale' ? 0 : Math.floor(Date.now() / 1000), baseFeePerGas: 1n }),
    getBalance: async () => condition === 'low-reserve' ? 0n : config.reserve + config.maxTransactionCost,
  }
  const oracle = { rates: async () => {
    if (condition === 'pricing') throw new Error('upstream-credential-must-not-leak')
    return Object.fromEntries(TOKENS.map((token) => [getAddress(token.address), 1n]))
  } }
  if (condition === 'disk') mocks.disk.mockReturnValue({ bavail: 1, bsize: 1 })
  const result = await monitor({ ...config, state: path, operatorAddress: Wallet.createRandom().address }, provider as unknown as JsonRpcProvider, oracle, 4340)
  const expected = { 'low-reserve': 'low-gas-reserve', pending: 'pending-nonce', fee: 'missing-fee-assurance',
    pricing: 'stale-fee-pricing', stale: 'stale-read-node', offline: 'health-unreachable', disk: 'low-disk' }[condition]
  expect(result.ok).toBe(condition === 'healthy')
  if (expected) expect(result.alerts).toContain(expected)
  expect(JSON.stringify(result)).not.toContain('upstream-credential')
  expect(monitorMetrics(result)).toContain(`ophis_broadcaster_monitor_ok ${result.ok ? 1 : 0}`)
  if (expected) expect(monitorMetrics(result)).toContain(`reason="${expected}"`)
  expect(monitorMetrics(result)).not.toContain('gasBalance')
})

it('rejects metric-label injection and excludes private fee balances from monitor output', async () => {
  expect(() => monitorMetrics({ ok: false, alerts: ['invalid"\nmetric 1'] })).toThrow('Invalid monitor label')
  const health = { ready: true, locked: false, synchronized: true, pending: 0, feeAssurancePending: 0, errors: 0,
    feeBalances: { privateFeeAmount: 'do-not-export' } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(health))))
  const provider = { getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000), baseFeePerGas: 1n }),
    getBalance: async () => config.reserve + config.maxTransactionCost }
  const result = await monitor({ ...config, state: path, operatorAddress: Wallet.createRandom().address }, provider as unknown as JsonRpcProvider,
    { rates: async () => Object.fromEntries(TOKENS.map((token) => [getAddress(token.address), 1n])) }, 4340)
  expect(JSON.stringify(result)).not.toContain('do-not-export')
  expect(result.ok).toBe(true)
})
