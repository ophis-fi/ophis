import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { id, Transaction, Wallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { CommitmentType, OutputType, TokenType, TransactNote, type TXO } from '@railgun-community/engine'
import { getRailgunWalletAddressData } from '@railgun-community/wallet'
import { CreditLedger, creditCharge, type CreditAttempt } from '../src/credit'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { CHAIN, CHAIN_ID, NETWORK, TOKENS } from '../src/config'
import { RailgunSDK } from '../src/sdk'
import { Store } from '../src/storage'
import { cliBacking } from './main-sdk.fixture'
import type { CreditBacking } from '../src/credit-backing'
import { config } from './request.fixture'
import { noteHash } from '../src/credit-owner-payment'
import { creditBackingEvidence } from '../src/credit-backing'

const reads = vi.hoisted(() => ({ refresh: vi.fn(), txos: vi.fn() }))
vi.mock('@railgun-community/wallet', async (importOriginal) => ({
  ...await importOriginal<typeof import('@railgun-community/wallet')>(),
  refreshBalances: reads.refresh,
  walletForID: () => ({ TXOs: reads.txos }),
}))

// Public address only; no wallet data, viewing key or owner database is loaded.
const recipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
const operator = Wallet.createRandom(), owner = Wallet.createRandom().address, other = Wallet.createRandom().address
const scope = { chainId: CHAIN_ID, operator: operator.address, recipient, token: TOKENS[0].address }
let root: string, store: Store, ledger: CreditLedger, sdk: RailgunSDK, synchronized: boolean
let finalized: number | null, network: bigint, position: number, currentNotes: TXO[]
let provider: JsonRpcProvider
const makeProvider = () => ({
  getNetwork: async () => ({ chainId: network }),
  getBlock: async (tag: number | string) => finalized === null ? null : { number: typeof tag === 'number' ? tag : finalized, hash: id('finalized'), timestamp: Math.floor(Date.now()/1000) },
  call: async () => '0x' + '0'.repeat(64),
  getLogs: async () => [],
}) as unknown as JsonRpcProvider

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ophis-credit-backing-'))
  store = new Store(root)
  ledger = new CreditLedger(store, scope)
  sdk = new RailgunSDK(config, { gasKey: operator.privateKey, encryptionKey: '11'.repeat(32) }, store)
  sdk.walletId = 'synthetic-view-only-wallet'; sdk.address = recipient
  synchronized = true; finalized = 100; network = CHAIN; position = 0; currentNotes = []
  provider = makeProvider()
  vi.spyOn(sdk, 'ready').mockImplementation(() => synchronized)
  reads.refresh.mockReset().mockResolvedValue(undefined)
  reads.txos.mockReset().mockResolvedValue([])
})
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(root, { recursive: true, force: true }) })

function deposit(amount: bigint, suffix = '', claimant = owner) {
  ledger.deposit({ owner: claimant, amount, commitment: id(`deposit-note${suffix}`), transactionHash: id(`deposit-tx${suffix}`),
    tree: 0, position: suffix ? 1 : 0, blockNumber: 90, blockHash: id('deposit-block') })
}
function attempt(backing: CreditBacking): CreditAttempt {
  const gasBudget = 210_000n, rate = 115n * 10n ** 16n, collectionAllowance = 10n
  return { key: id('backed-attempt'), owner, sequence: ledger.nextSequence(owner), envelope: 'synthetic authorized envelope', nonce: 0,
    unsigned: Transaction.from({ type: 2, chainId: CHAIN, nonce: 0, to: other, value: 0n,
      gasLimit: 21_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }).unsignedSerialized,
    gasBudget, rate, collectionAllowance, maximumCharge: creditCharge(gasBudget, rate, collectionAllowance),
    expiration: Date.now() + 60_000, dailyBudget: 10n ** 18n, backing }
}
async function finalizedReceipt(hash: string, gasUsed = 21_000n, gasPrice = 5n) {
  const receipt = { hash, blockNumber: 100, blockHash: id('settlement-block'), gasUsed, gasPrice, status: 1 } as TransactionReceipt
  const chain = { getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
    getBlock: async () => ({ number: 100, hash: receipt.blockHash, timestamp: 1_800_000_000 }),
  } as unknown as JsonRpcProvider
  return finalizedCreditReceipt(chain, hash)
}
function note(value: bigint, options: { block?: number; spent?: boolean; token?: string; change?: boolean } = {}): TXO {
  const blockNumber = options.block ?? 90
  const tokenAddress = options.token ?? TOKENS[0].address
  return { tree: 0, position: position++, txid: id(`note-${value}-${blockNumber}-${tokenAddress}`), timestamp: 1_800_000_000,
    blockNumber, spendtxid: options.spent ? id('owner-spend') : false, nullifier: id(`synthetic-nullifier-${position}`),
    note: TransactNote.createTransfer(getRailgunWalletAddressData(recipient), undefined, value,
      { tokenType: TokenType.ERC20, tokenAddress, tokenSubID: '0' }, false,
      options.change ? OutputType.Change : OutputType.Transfer, undefined),
    commitmentType: CommitmentType.TransactCommitmentV2, poisPerList: undefined,
    blindedCommitment: undefined, transactCreationRailgunTxid: undefined }
}

function setNotes(notes: TXO[]) { currentNotes = notes; reads.txos.mockResolvedValue(notes) }
async function check(required: bigint) {
  if (required < 0n) throw new Error('Invalid liability')
  const known = currentNotes.filter((note) => note.note.tokenData.tokenAddress.toLowerCase() === TOKENS[0].address.toLowerCase() && note.note.value > 0n)
    .map((note) => ({ tree: note.tree, position: note.position, commitment: noteHash(note), transactionHash: note.txid,
      blockNumber: note.blockNumber, blockHash: id('finalized'), amount: note.note.value.toString() }))
  const backing = await sdk.accountedCreditBacking(provider, known, 2)
  if (creditBackingEvidence(backing).bounded < required) throw new Error('Insufficient bounded backing')
}

describe('prepaid liabilities remain user funds', () => {
  it('includes every owner, active reservation and the full pending refund gross across restart', async () => {
    const total = 9_007_199_254_740_993n
    deposit(total); deposit(800n, 'other', other)
    const backing = await cliBacking(ledger.accountedNotes())
    ledger.reserve(attempt(backing))
    ledger.reserveRefund(id('pending-refund'), owner, '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', 300n, 250n, ledger.nextSequence(owner), backing, attempt(backing).maximumCharge)
    expect(ledger.balance(owner).available).toBe(total - attempt(backing).maximumCharge - 300n)
    expect(ledger.liability()).toBe(total + 800n)
    store.close(); store = new Store(root); ledger = new CreditLedger(store, scope)
    expect(ledger.liability()).toBe(total + 800n)
    expect(ledger.refund(id('pending-refund'))?.transaction_hash).toBeNull()
  })

  it('deducts only a finalized actual charge, never an unsigned hold or unknown nonce consumption', async () => {
    deposit(1_000_000n)
    const a = attempt(await cliBacking(ledger.accountedNotes())); ledger.reserve(a)
    const raw = await operator.signTransaction(Transaction.from(a.unsigned)), hash = ledger.attachSignature(a.key, raw)
    store.confirmed(a.key, a.gasBudget, Date.now())
    expect(ledger.liability()).toBe(1_000_000n)
    const receipt = await finalizedReceipt(hash)
    const charged = ledger.settle(a.key, receipt)
    expect(charged).toBe(creditCharge(105_000n, a.rate, a.collectionAllowance))
    expect(ledger.liability()).toBe(1_000_000n - charged)
    expect(ledger.liability()).toBe(ledger.balance(owner).available)
  })


})

describe('fresh finalized wrapped-native backing', () => {
  it('rejects a successful public receipt before refreshing private history', async () => {
    const hash = id('ordinary public transfer'), blockHash = id('ordinary block')
    const chain = { getNetwork: async () => ({ chainId: CHAIN }),
      getBlock: async () => ({ number: 100, hash: blockHash, timestamp: Math.floor(Date.now() / 1000) }),
      getTransactionReceipt: async () => ({ hash, blockHash, blockNumber: 100, status: 1, gasUsed: 1n, gasPrice: 1n, logs: [] }),
    } as unknown as JsonRpcProvider
    await expect(sdk.confirmedCredits(chain, scope, ledger.id, owner, hash)).rejects.toThrow('No canonical private transfer')
    expect(reads.refresh).not.toHaveBeenCalled()
  })
  it('counts only positive unspent wrapped-native notes at or before finality, including finalized change', async () => {
    setNotes([note(7n), note(3n, { change: true, block: 100 }), note(1_000n, { spent: true }),
      note(1_000n, { token: TOKENS[1].address }), note(1_000n, { block: 101, change: true }), note(0n)])
    await expect(check(7n)).resolves.toBeUndefined()
    await expect(check(8n)).rejects.toThrow('bounded backing')
    expect(reads.refresh).toHaveBeenCalledWith(NETWORK.chain, ['synthetic-view-only-wallet'])
  })

  it('does not reuse a previous backing result after owner spending or before replacement change finalizes', async () => {
    setNotes([note(100n)])
    await expect(check(100n)).resolves.toBeUndefined()
    reads.refresh.mockImplementationOnce(async () => {
      setNotes([note(100n, { spent: true }), note(100n, { block: 101, change: true })])
    })
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001)
    await expect(check(100n)).rejects.toThrow('bounded backing')
    finalized = 101
    await expect(check(100n)).resolves.toBeUndefined()
  })

  it('rejects stale cached notes if a refresh resolves without completed wallet synchronization', async () => {
    setNotes([note(100n)])
    reads.refresh.mockImplementationOnce(async () => { synchronized = false })
    await expect(check(100n)).rejects.toThrow()
  })

  it('fails closed on refresh errors, wrong network, missing finality and invalid liabilities', async () => {
    setNotes([note(100n)])
    reads.refresh.mockRejectedValueOnce(new Error('Synthetic scan unavailable'))
    await expect(check(100n)).rejects.toThrow('scan unavailable')
    network = CHAIN === 1n ? 56n : 1n
    await expect(check(100n)).rejects.toThrow()
    network = CHAIN; finalized = null
    await expect(check(100n)).rejects.toThrow('finalized')
    finalized = 100
    await expect(check(-1n)).rejects.toThrow()
  })

  it('coalesces concurrent SDK refreshes, expires the short cache, and retries failures', async () => {
    setNotes([note(100n)])
    let finish!: () => void
    reads.refresh.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    const first = check(100n), second = check(100n)
    expect(reads.refresh).toHaveBeenCalledTimes(1)
    finish(); await Promise.all([first, second])
    await check(100n)
    expect(reads.refresh).toHaveBeenCalledTimes(1)
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5_001)
    reads.refresh.mockRejectedValueOnce(new Error('temporary refresh outage'))
    await expect(check(100n)).rejects.toThrow('temporary refresh outage')
    await expect(check(100n)).resolves.toBeUndefined()
    expect(reads.refresh).toHaveBeenCalledTimes(3)
  })

  it('checks many accounted notes concurrently at one pinned block with deduplicated provenance reads', async () => {
    setNotes(Array.from({ length: 65 }, () => note(100n)))
    let active = 0, peak = 0
    const blockRead = vi.spyOn(provider, 'getBlock')
    const nullifierRead = vi.spyOn(provider, 'call').mockImplementation(async (request) => {
      expect(request.blockTag).toBe(100)
      active++; peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1)); active--
      return '0x' + '0'.repeat(64)
    })
    await expect(check(100n)).resolves.toBeUndefined()
    expect(nullifierRead).toHaveBeenCalledTimes(65)
    expect(peak).toBe(16)
    expect(blockRead.mock.calls.filter(([number]) => number === 90)).toHaveLength(1)
  })
})
