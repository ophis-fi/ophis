import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { id, type TransactionReceipt } from 'ethers'
import { EngineEvent } from '@railgun-community/engine'
import type { WalletSession } from './wallet'

const state = vi.hoisted(() => ({ records: new Map<string, unknown>(), required: [] as unknown[], covered: '[]',
  engine: undefined as any, completions: [] as (() => void)[], behind: false, failWrite: false }))
vi.mock('./config', async original => ({ ...await original<typeof import('./config')>(), CHAIN_ID: 8453, CHAIN: 8453n, ENVIRONMENT: 'ethereum' }))
vi.mock('./storage', () => ({ artifacts: {}, walletDB: {}, readPreference: vi.fn(), writePreference: vi.fn(), encryptionKey: vi.fn(),
  readPrivateState: async (_session: unknown, key: string) => structuredClone(state.records.get(key)),
  writePrivateState: async (_session: unknown, key: string, value: unknown) => {
    if (state.failWrite) throw new Error('disk full')
    state.records.set(key, structuredClone(value))
  },
  deletePrivateState: async (_session: unknown, key: string) => { state.records.delete(key) } }))
vi.mock('../base-history-sdk', () => ({ installBaseHistory: async () => ({
  setRequiredReceipts: (receipts: unknown[]) => { state.required = structuredClone(receipts) },
  assertReceiptCoverage: () => { if (state.behind || state.covered !== JSON.stringify(state.required)) throw new Error('history behind receipt') },
}) }))
vi.mock('ethers', async original => ({ ...await original<typeof import('ethers')>(), JsonRpcProvider: class {
  getNetwork = async () => ({ chainId: 8453n }); send = async () => undefined; destroy = vi.fn()
} }))
vi.mock('@railgun-community/wallet', async original => ({ ...await original<typeof import('@railgun-community/wallet')>(),
  startRailgunEngine: vi.fn(), stopRailgunEngine: vi.fn(), getEngine: () => state.engine,
  getProver: () => ({ setSnarkJSGroth16: vi.fn() }), loadProvider: vi.fn(), setOnBalanceUpdateCallback: vi.fn(),
  fullWalletForID: () => ({}), onBalancesUpdate: vi.fn(),
  refreshBalances: async () => {
    const receipts = JSON.stringify(state.required)
    state.engine.emit(EngineEvent.UTXOMerkletreeHistoryScanUpdate, { chain: { id: 8453 }, txidVersion: 'V2_PoseidonMerkle', scanStatus: 'Updated' })
    await new Promise<void>(resolve => { state.completions.push(() => {
      state.covered = receipts
      state.engine.emit(EngineEvent.UTXOMerkletreeHistoryScanUpdate, { chain: { id: 8453 }, txidVersion: 'V2_PoseidonMerkle', scanStatus: 'Complete' })
      resolve()
    }) })
  },
}))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
const receipt = { status: 1, hash: id('receipt'), blockNumber: 56_000_000, blockHash: id('block') } as TransactionReceipt
async function fixture() {
  state.engine = Object.assign(new EventEmitter(), { getUTXOMerkletree: () => ({ isScanning: false }) })
  state.required = []; state.covered = '[]'; state.behind = false; state.failWrite = false; state.records.clear(); state.completions = []
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}) } })
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:4319' }); vi.stubGlobal('document', { getElementById: () => null })
  const wallet = await import('./wallet')
  await wallet.startWalletEngine(() => {}, () => {})
  state.completions.shift()!()
  const session = { info: { id: 'synthetic-wallet' }, accounts: { scanHistoryForEphemeralIndex: vi.fn() },
    provider: { getBlock: async () => ({ hash: receipt.blockHash }), getTransactionReceipt: vi.fn() } } as unknown as WalletSession
  return { ...wallet, session }
}

it('immediately invalidates an older flight, persists the new receipt before waiting, and cannot inherit stale readiness', async () => {
  const f = await fixture(), old = f.syncWallet(f.session), oldResult = old.catch(error => error)
  await vi.waitFor(() => expect(state.completions).toHaveLength(1))
  const next = f.syncWallet(f.session, receipt)
  expect(() => f.requireWalletSync()).toThrow('not synchronized')
  await vi.waitFor(() => expect(state.records.get('baseHistoryReceipts')).toHaveLength(1))
  state.completions.shift()!()
  expect(await oldResult).toBeInstanceOf(Error)
  expect(state.records.has('baseHistoryReceipts')).toBe(true)
  await vi.waitFor(() => expect(state.completions).toHaveLength(1))
  expect(() => f.requireWalletSync()).toThrow('not synchronized')
  state.completions.shift()!(); await next
  expect(state.records.has('baseHistoryReceipts')).toBe(false)
  expect(() => f.requireWalletSync()).not.toThrow()
})

it('loads a persisted receipt on ordinary sync and keeps it until coverage catches up', async () => {
  const f = await fixture()
  state.records.set('baseHistoryReceipts', [{ hash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash }])
  state.behind = true
  const first = f.syncWallet(f.session), firstResult = first.catch(error => error)
  await vi.waitFor(() => expect(state.completions).toHaveLength(1)); state.completions.shift()!()
  expect(await firstResult).toBeInstanceOf(Error)
  expect(state.records.has('baseHistoryReceipts')).toBe(true)
  expect(() => f.requireWalletSync()).toThrow('not synchronized')
  state.behind = false
  const second = f.syncWallet(f.session)
  await vi.waitFor(() => expect(state.completions).toHaveLength(1)); state.completions.shift()!(); await second
  expect(state.records.has('baseHistoryReceipts')).toBe(false)
  expect(() => f.requireWalletSync()).not.toThrow()
})

it('cannot restore readiness through ordinary sync after receipt persistence failed', async () => {
  const f = await fixture()
  state.failWrite = true
  await expect(f.syncWallet(f.session, receipt)).rejects.toThrow('disk full')
  state.failWrite = false
  await expect(f.syncWallet(f.session)).rejects.toThrow('could not be saved')
  expect(() => f.requireWalletSync()).toThrow('not synchronized')
  expect(state.completions).toHaveLength(0)
  const retry = f.syncWallet(f.session, receipt)
  await vi.waitFor(() => expect(state.completions).toHaveLength(1)); state.completions.shift()!(); await retry
  expect(() => f.requireWalletSync()).not.toThrow()
})
