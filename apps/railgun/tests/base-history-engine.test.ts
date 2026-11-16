import { afterEach, expect, it, vi } from 'vitest'
import { RailgunEngine, TXIDVersion, EngineEvent } from '@railgun-community/engine'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { id } from 'ethers'

const require = createRequire(import.meta.url)
const { ContractStore } = require(join(dirname(require.resolve('@railgun-community/engine')), 'contracts/contract-store.js'))
const { AbstractWallet } = require(join(dirname(require.resolve('@railgun-community/engine')), 'wallet/abstract-wallet.js'))
const { Database } = require(join(dirname(require.resolve('@railgun-community/engine')), 'database/database.js'))
const chain = { type: 0, id: 8453 }, version = TXIDVersion.V2_PoseidonMerkle
afterEach(() => { vi.restoreAllMocks(); ContractStore.railgunSmartWalletContracts.del(null, chain) })
function fixture() {
  const values = new Map<string, string>(), marker = 'chain_sync_info/ophis_base_history_v1'
  const derived = new Set<string>(), tree = { isScanning: false, clearWriteQueue: vi.fn(), updateTreesFromWriteQueue: vi.fn(),
    getUnshieldEventsDBPath: () => ['utxo', 'unshield'],
    hasPendingWrites: () => false, getFirstInvalidMerklerootTree: () => undefined,
    getLatestTreeAndIndex: async () => ({ tree: 0, index: 0 }), getLatestIndexForTree: async () => 0,
    getRoot: async () => id('root'), clearDataForMerkletree: vi.fn(async () => { derived.clear() }) }
  const engine = Object.create(RailgunEngine.prototype) as any
  Object.assign(engine, { baseHistoryResetReady: true, wallets: {}, hasUTXOMerkletree: () => true, hasTXIDMerkletree: () => false,
    getUTXOMerkletree: () => tree, getUTXOMerkletreeHistoryVersion: async () => 999, emit: vi.fn(),
    db: { get: vi.fn(async (path: string[]) => { const key = path.join('/'); if (!values.has(key)) throw Object.assign(new Error('missing'), { notFound: true }); return values.get(key) }),
      put: vi.fn(async (path: string[], value: string) => { values.set(path.join('/'), value) }),
      clearNamespace: vi.fn(async () => {}) },
    unshieldListener: vi.fn(async () => { derived.add('unshield') }), nullifierListener: vi.fn(async () => { derived.add('nullifier') }),
    commitmentListener: vi.fn(), decryptBalancesAllWallets: vi.fn(), performQuickSync: vi.fn(), slowSyncV2: vi.fn(),
    scanTXIDHistoryV2: vi.fn(), allWallets: () => [{ clearDecryptedBalancesAllTXIDVersions: vi.fn() }] })
  ContractStore.railgunSmartWalletContracts.set(null, chain, {} as never)
  vi.spyOn(RailgunEngine as any, 'validateMerkleroot').mockResolvedValue(true)
  const validate = vi.fn(async () => {}), checkpoint = { blockNumber: 50_224_800, blockHash: id('head') }
  const source = vi.fn(async () => ({ events: { commitmentEvents: [], nullifierEvents: [], unshieldEvents: [] }, checkpoint, validate }))
  engine.setBaseHistorySource(source)
  engine.emit.mockImplementation((event: string) => {
    if (event === EngineEvent.UTXOScanDecryptBalancesComplete) queueMicrotask(() => engine.emitScanEventHistoryComplete(version, chain))
  })
  return { engine, values, marker, source, validate, checkpoint, tree, derived }
}

it('runs the real strict SDK branch without any legacy fallback and atomically binds height/hash after validation', async () => {
  const f = fixture()
  await f.engine.scanContractHistory(chain, [])
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual(f.checkpoint)
  expect(f.validate).toHaveBeenCalledTimes(2)
  expect(f.engine.performQuickSync).not.toHaveBeenCalled(); expect(f.engine.slowSyncV2).not.toHaveBeenCalled()
  expect(f.engine.scanTXIDHistoryV2).not.toHaveBeenCalled()
  expect(f.engine.db.put.mock.calls.map((call: any[]) => JSON.parse(call[1]))).toEqual([{ dirty: true }, f.checkpoint])
})

it.each(['source', 'root', 'completion', 'decryption'])('never falls back or marks incomplete %s history as complete', async point => {
  const f = fixture()
  if (point === 'source') f.source.mockRejectedValue(new Error('cache unavailable'))
  if (point === 'root') vi.mocked((RailgunEngine as any).validateMerkleroot).mockResolvedValue(false)
  if (point === 'completion') f.validate.mockRejectedValue(new Error('canonical head changed'))
  if (point === 'decryption') f.engine.decryptBalancesAllWallets.mockImplementation(async (_v: unknown, _c: unknown, _w: unknown, _p: unknown, complete: boolean) => {
    if (complete) throw new Error('decryption failed')
  })
  await f.engine.scanContractHistory(chain, [])
  expect(f.engine.performQuickSync).not.toHaveBeenCalled(); expect(f.engine.slowSyncV2).not.toHaveBeenCalled()
  expect(f.engine.scanTXIDHistoryV2).not.toHaveBeenCalled()
  expect(f.engine.emit.mock.calls.some(([event]: unknown[]) => event === EngineEvent.UTXOScanDecryptBalancesComplete)).toBe(false)
  if (point === 'source') expect(f.values.has(f.marker)).toBe(false)
  else expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true })
  expect(f.tree.isScanning).toBe(false)
})

it('dirty noncommitment writes survive failure as unready and cannot become clean after a nullifier-only reorg', async () => {
  const f = fixture()
  f.validate.mockRejectedValueOnce(new Error('reorg after listener writes'))
  await f.engine.scanContractHistory(chain, [])
  expect(f.derived.has('nullifier')).toBe(true)
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true })
  f.source.mockClear(); f.validate.mockClear()
  // A restarted process has no reset-ready flag; only the durable dirty marker remains.
  f.engine.baseHistoryResetReady = false
  await f.engine.scanContractHistory(chain, [])
  expect(f.source).not.toHaveBeenCalled(); expect(f.validate).not.toHaveBeenCalled()
  expect(f.engine.emit.mock.calls.at(-1)?.[1]).toMatchObject({ scanStatus: 'Incomplete', requiresRescan: true })
})

it('requires an explicit derived reset for legacy state and preserves keys, sent history and Ophis recovery records', async () => {
  const f = fixture()
  f.engine.baseHistoryResetReady = false
  f.values.set('wallet/key', 'synthetic-key'); f.values.set('wallet/sent', 'synthetic-sent'); f.values.set('ophis/recovery', 'synthetic-proof')
  f.derived.add('old-nullifier')
  await f.engine.scanContractHistory(chain, [])
  expect(f.source).not.toHaveBeenCalled()
  await f.engine.clearUTXOMerkletreeAndLoadedWalletsAllTXIDVersions(chain)
  expect(f.derived.size).toBe(0)
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true })
  await f.engine.scanContractHistory(chain, [])
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual(f.checkpoint)
  expect([...f.values.entries()].filter(([key]) => key !== f.marker)).toEqual([
    ['wallet/key', 'synthetic-key'], ['wallet/sent', 'synthetic-sent'], ['ophis/recovery', 'synthetic-proof'],
  ])
})

it('invalidates the strict checkpoint before a failed explicit reset and remains unready after restart', async () => {
  const f = fixture(); await f.engine.scanContractHistory(chain, [])
  f.tree.clearDataForMerkletree.mockRejectedValueOnce(new Error('disk interrupted reset'))
  await expect(f.engine.clearUTXOMerkletreeAndLoadedWalletsAllTXIDVersions(chain)).rejects.toThrow('interrupted')
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true })
  f.engine.baseHistoryResetReady = false; f.source.mockClear()
  await f.engine.scanContractHistory(chain, [])
  expect(f.source).not.toHaveBeenCalled()
})

it('initializes a pristine database through the existing versioned reset then completes strict history', async () => {
  const f = fixture(); f.engine.baseHistoryResetReady = false
  f.engine.getUTXOMerkletreeHistoryVersion = async () => undefined
  f.engine.setUTXOMerkletreeHistoryVersion = vi.fn()
  await Promise.all([f.engine.scanContractHistory(chain, []), f.engine.scanContractHistory(chain, [])])
  expect(f.engine.setUTXOMerkletreeHistoryVersion).toHaveBeenCalledOnce()
  expect(f.tree.clearDataForMerkletree).toHaveBeenCalledOnce()
  expect(f.source).toHaveBeenCalledOnce()
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual(f.checkpoint)
  expect(f.engine.performQuickSync).not.toHaveBeenCalled()
})

it('refuses an explicit rebuild during initial migration before the SDK tree scanning flag is set', async () => {
  const f = fixture(); let release!: (version: number) => void
  f.engine.getUTXOMerkletreeHistoryVersion = () => new Promise(resolve => { release = resolve })
  const running = f.engine.scanContractHistory(chain, [])
  await expect(f.engine.fullRescanUTXOMerkletreesAndWallets(chain, [])).rejects.toThrow('Wait for')
  release(999); await running
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual(f.checkpoint)
})

it('does not enter migration while an explicit reset owns the tree scanning flag', async () => {
  const f = fixture(); f.tree.isScanning = true
  f.engine.getUTXOMerkletreeHistoryVersion = vi.fn(async () => undefined)
  await f.engine.scanContractHistory(chain, [])
  expect(f.engine.getUTXOMerkletreeHistoryVersion).not.toHaveBeenCalled()
  expect(f.source).not.toHaveBeenCalled()
})

it('retains scan serialization through delayed wallet completion so stale Complete cannot revive a failed newer scan', async () => {
  const f = fixture(); f.engine.emit.mockImplementation(() => {})
  const first = f.engine.scanContractHistory(chain, [])
  await vi.waitFor(() => expect(f.engine.emit.mock.calls.some(([name]: string[]) => name === EngineEvent.UTXOScanDecryptBalancesComplete)).toBe(true))
  const concurrent = f.engine.scanContractHistory(chain, [])
  expect(f.source).toHaveBeenCalledOnce()
  await expect(f.engine.fullRescanUTXOMerkletreesAndWallets(chain, [])).rejects.toThrow('Wait for')
  f.engine.emitScanEventHistoryComplete(version, chain)
  await Promise.all([first, concurrent])
  f.source.mockRejectedValueOnce(new Error('new scan failed'))
  await f.engine.scanContractHistory(chain, [])
  const count = f.engine.emit.mock.calls.length
  f.engine.emitScanEventHistoryComplete(version, chain)
  expect(f.engine.emit).toHaveBeenCalledTimes(count)
  expect(f.engine.emit.mock.calls.at(-1)?.[1]).toMatchObject({ scanStatus: 'Incomplete' })
})

it('marks a clean checkpoint dirty when its canonical block changed', async () => {
  const f = fixture(); await f.engine.scanContractHistory(chain, [])
  f.source.mockRejectedValueOnce(Object.assign(new Error('checkpoint reorg'), { requiresBaseHistoryRescan: true }))
  await f.engine.scanContractHistory(chain, [])
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true })
  expect(f.engine.emit.mock.calls.at(-1)?.[1]).toMatchObject({ scanStatus: 'Incomplete', requiresRescan: true })
})

it('standalone unshield clearing invalidates the checkpoint before changing noncommitment state', async () => {
  const f = fixture(); await f.engine.scanContractHistory(chain, [])
  Object.assign(f.tree, { getUnshieldEventsDBPath: () => ['utxo', 'unshield'] })
  f.engine.db.clearNamespace.mockImplementationOnce(async () => expect(JSON.parse(f.values.get(f.marker)!)).toEqual({ dirty: true }))
  await f.engine.clearSyncedUnshieldEvents(version, chain)
  f.source.mockClear(); await f.engine.scanContractHistory(chain, [])
  expect(f.source).not.toHaveBeenCalled()
})

it('uses real SDK wallet namespaces to preserve sent commitments, keys and independent recovery during explicit rescan', async () => {
  const f = fixture(), records = new Map<string, unknown>(), wallet = Object.create(AbstractWallet.prototype)
  const details = { [version]: { treeScannedHeights: [3], creationTree: 0 } }
  Object.assign(wallet, { id: '11'.repeat(32), getWalletDetailsMap: async () => details,
    isClearingBalances: { set: vi.fn() }, invalidateCommitmentsCache: vi.fn(),
    db: { clearNamespace: async (path: string[]) => {
      const prefix = Database.pathToKey(path)
      for (const key of records.keys()) if (key === prefix || key.startsWith(prefix + ':')) records.delete(key)
    }, put: async (path: string[], value: unknown) => { records.set(Database.pathToKey(path), value) } } })
  const received = Database.pathToKey(wallet.getWalletReceiveCommitmentDBPrefix(chain, 0, 0))
  const sent = Database.pathToKey(wallet.getWalletSentCommitmentDBPrefix(chain, 0, 0))
  const key = Database.pathToKey(['wallet-details', wallet.id]), recovery = 'ophis-external-db/pending-operation'
  records.set(received, 'received'); records.set(sent, 'sent'); records.set(key, 'encrypted-key'); records.set(recovery, 'saved-proof')
  f.engine.allWallets = () => [wallet]
  await f.engine.fullRescanUTXOMerkletreesAndWallets(chain, [])
  expect(records.has(received)).toBe(false)
  expect(records.get(sent)).toBe('sent'); expect(records.get(key)).toBe('encrypted-key'); expect(records.get(recovery)).toBe('saved-proof')
  expect(details[version]).toEqual({ treeScannedHeights: [], creationTree: 0 })
  expect(JSON.parse(f.values.get(f.marker)!)).toEqual(f.checkpoint)
})
