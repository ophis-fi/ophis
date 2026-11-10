import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { id, Transaction, Wallet, type JsonRpcProvider, type TransactionReceipt } from 'ethers'
import { Store } from '../src/storage'
import { CreditLedger, creditCharge, type CreditAttempt } from '../src/credit'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { creditRefundMemo } from '../../railgun/credit-protocol'
import { CHAIN, CHAIN_ID } from '../src/config'

const operator = Wallet.createRandom(), owner = Wallet.createRandom().address, other = Wallet.createRandom().address
const recipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
const scope = { chainId: CHAIN_ID, operator: operator.address, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', token: Wallet.createRandom().address }
let root: string, store: Store, ledger: CreditLedger
// Ledger boundary tests use explicit verified-evidence doubles; canonical note/debit/trace checks have dedicated suites.
const verified = vi.hoisted(() => ({ debits: new WeakMap<object, any>(), backing: new WeakMap<object, any>() }))
vi.mock('../src/credit-owner-payment', async (original) => ({ ...await original<typeof import('../src/credit-owner-payment')>(),
  ownerDebitEvidence: (proof: object) => { const value = verified.debits.get(proof); if (!value) throw new Error('Missing exact debit'); return value } }))
vi.mock('../src/credit-backing', async (original) => ({ ...await original<typeof import('../src/credit-backing')>(),
  creditBackingEvidence: (proof: object) => { const value = verified.backing.get(proof); if (!value) throw new Error('Missing backing'); return value } }))
function backing(amount = ledger.requiredBacking()) {
  const proof = { kind: 'verified-credit-backing' as const }
  verified.backing.set(proof, { available: amount, bounded: amount, maximumInputs: 2, checkedAt: Date.now() })
  return proof
}
function prepareRefund(key: string) {
  return ledger.prepareOwnerOperation({ kind: 'refund', refundKey: key, maximumPrivateFee: 0n, minimumNative: 0n,
    inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: 1500n }, backing())
}
function refundEvidence(receipt: TransactionReceipt, amount: bigint) {
  const proof = { kind: 'verified-owner-debit' as const }
  verified.debits.set(proof, { transactionHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    debit: amount, inputs: [], change: [] })
  return { debit: proof, backing: backing(ledger.requiredBacking() - amount) }
}

const payment = (amount = 10n ** 18n, suffix = '') => ({ owner, amount, commitment: id(`note${suffix}`),
  tree: 0, position: suffix ? 1 : 0, transactionHash: id(`payment${suffix}`), blockNumber: 10, blockHash: id('block') })
function attempt(overrides: Partial<CreditAttempt> = {}): CreditAttempt {
  const unsigned = Transaction.from({ type: 2, chainId: CHAIN, nonce: 0, to: other, value: 0n,
    gasLimit: 100_000n, maxFeePerGas: 100n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  const rate = 115n * 10n ** 16n, gasBudget = 10_000_000n, collectionAllowance = 1_000n
  return { key: id('attempt'), owner, sequence: ledger.nextSequence(owner), envelope: 'encrypted request', unsigned, nonce: 0, gasBudget,
    maximumCharge: creditCharge(gasBudget, rate, collectionAllowance), rate, collectionAllowance,
    expiration: Date.now() + 60_000, dailyBudget: 10n ** 18n, backing: backing(), ...overrides }
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ophis-credit-')); store = new Store(root); ledger = new CreditLedger(store, scope) })
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

describe('confirmed credit journal', () => {
  it('bounds repeated and advancing retirements to one durable owner row', () => {
    for (let i = 0; i < 100; i++) expect(ledger.nextSequence(other)).toBe(1)
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(0)
    ledger.deposit(payment())
    for (let sequence = 1; sequence <= 1000; sequence++)
      expect(ledger.retireUnreserved(id(`retired-${sequence}`), owner, 'execute', sequence))
        .toEqual({ sequence, retiredThrough: sequence })
    for (let i = 0; i < 1000; i++)
      expect(ledger.retireUnreserved(id(`old-hash-${i}`), owner, 'refund', 1)).toEqual({ sequence: 1, retiredThrough: 1000 })
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toEqual([{ owner, sequence: 1000 }])
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
    for (const sql of ['DELETE FROM credit_owner_sequences', 'UPDATE credit_owner_sequences SET sequence=1',
      'UPDATE credit_owner_sequences SET sequence=sequence+2', 'UPDATE credit_owner_sequences SET owner=NULL'])
      expect(() => store.db.exec(sql)).toThrow()
    expect(() => store.db.prepare('INSERT OR REPLACE INTO credit_owner_sequences VALUES(?,1)').run(owner)).toThrow()
    store.close(); store = new Store(root); ledger = new CreditLedger(store, scope)
    expect(ledger.nextSequence(owner)).toBe(1001)
    expect(() => ledger.reserve(attempt({ sequence: 1000 }))).toThrow('already consumed')
    expect(() => ledger.reserveRefund(id('late refund'), owner, recipient, 100n, 90n, 1000, backing(), 1n)).toThrow('already consumed')
    expect(() => ledger.retireUnreserved(id('future'), owner, 'refund', 1002)).toThrow('not next')
    expect(ledger.nextSequence(owner)).toBe(1001)
    expect(ledger.balance(owner).available).toBe(10n ** 18n)
  }, 20_000)
  it('requires historical funding for a new counter and preserves recovery after a full refund', async () => {
    expect(ledger.retireUnreserved(id('legacy absent'), owner, 'execute')).toEqual({ sequence: null, retiredThrough: 0 })
    expect(() => ledger.retireUnreserved(id('unfunded'), owner, 'execute', 1)).toThrow('deposit history')
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(0)
    ledger.deposit(payment(100n))
    const key = id('full refund')
    ledger.reserveRefund(key, owner, recipient, 100n, 90n, 1, backing(), 1n)
    const receipt = { hash: id('full refund transaction'), blockNumber: 10, blockHash: id('full refund block'), status: 1,
      gasUsed: 21_000n, gasPrice: 1n } as TransactionReceipt
    await finalizedCreditReceipt({ getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 10, hash: receipt.blockHash, timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider, receipt.hash)
    prepareRefund(key); ledger.recordRefundPayout(key, receipt)
    ledger.settleRefund(key, { receipt, commitment: id('full refund note'), recipient, amount: 90n, token: scope.token,
      memo: creditRefundMemo(scope, ledger.id, key), ...refundEvidence(receipt, 90n) })
    expect(ledger.balance(owner).available).toBe(0n)
    expect(ledger.retireUnreserved(id('execute'), owner, 'execute', 2)).toEqual({ sequence: 2, retiredThrough: 2 })
    expect(ledger.retireUnreserved(id('execute'), owner, 'execute', 2)).toEqual({ sequence: 2, retiredThrough: 2 })
    expect(ledger.retireUnreserved(id('refund'), owner, 'refund', 3)).toEqual({ sequence: 3, retiredThrough: 3 })
    expect(() => ledger.retireUnreserved(id('unfunded other'), other, 'execute', 1)).toThrow('deposit history')
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(1)
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
  })
  it('rejects invalid sequences and all new holds without a sequence at both API and SQLite boundaries', () => {
    ledger.deposit(payment())
    for (const sequence of [null, 0, -1, 0.1, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      expect(() => ledger.retireUnreserved(id('invalid'), owner, 'execute', sequence)).toThrow('valid prepaid request sequence')
      expect(() => ledger.reserve(attempt({ sequence: sequence as number }))).toThrow()
      expect(() => ledger.reserveRefund(id('invalid refund'), owner, recipient, 100n, 90n, sequence as number, backing(), 1n)).toThrow()
    }
    expect(() => ledger.reserve(attempt({ sequence: undefined as unknown as number }))).toThrow('sequence')
    expect(() => ledger.reserveRefund(id('legacy new'), owner, recipient, 100n, 90n, undefined as unknown as number, backing(), 1n)).toThrow('sequence')
    expect(() => store.db.prepare(`INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance)
      VALUES(?,?,?,?,?,?)`).run(id('old binary execute'), owner, attempt().unsigned, '100', '1000000000000000000', '0')).toThrow('sequence')
    expect(() => store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created) VALUES(?,?,?,?,?,?)')
      .run(id('old binary refund'), owner, recipient, '100', '90', Date.now())).toThrow('sequence')
    expect(() => store.db.prepare('INSERT INTO credit_retired_requests VALUES(?,?,?,?)')
      .run(id('old binary retirement'), owner, 'execute', Date.now())).toThrow('disabled')
    expect(store.db.prepare('SELECT * FROM credit_owner_sequences').all()).toHaveLength(0)
    expect(store.pending()).toHaveLength(0)
  })
  it('keeps old retirement rows immutable while requiring numeric recovery to advance the owner counter', () => {
    ledger.deposit(payment())
    const key = id('legacy tombstone')
    // Simulate an existing pre-upgrade row, then reinstate the upgrade's insertion fence.
    store.db.exec('DROP TRIGGER disable_new_credit_retirements')
    store.db.prepare('INSERT INTO credit_retired_requests VALUES(?,?,?,?)').run(key, owner, 'execute', Date.now())
    ledger = new CreditLedger(store, scope)
    expect(ledger.retireUnreserved(key, owner, 'execute')).toEqual({ sequence: null, retiredThrough: 0 })
    expect(() => ledger.retireUnreserved(key, other, 'execute', 1)).toThrow('identity changed')
    expect(() => ledger.retireUnreserved(key, owner, 'refund', 1)).toThrow('identity changed')
    expect(() => ledger.retireUnreserved(key, owner, 'execute', 2)).toThrow('not next')
    expect(ledger.retireUnreserved(key, owner, 'execute', 1)).toEqual({ sequence: 1, retiredThrough: 1 })
    expect(() => store.db.exec('DELETE FROM credit_retired_requests')).toThrow('immutable')
    expect(() => store.db.prepare('UPDATE credit_retired_requests SET owner=?').run(other)).toThrow('immutable')
    expect(() => store.db.prepare('INSERT OR REPLACE INTO credit_retired_requests VALUES(?,?,?,?)')
      .run(key, owner, 'execute', Date.now())).toThrow()
    expect(() => ledger.reserve(attempt({ key, sequence: 2 }))).toThrow('retired before reservation')
    expect(ledger.nextSequence(owner)).toBe(2)
  })
  it('never retires an unsigned or signed hold, a refund hold or inconsistent request state', async () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    expect(ledger.retireUnreserved(a.key, owner, 'execute')).toBe(false)
    expect(() => ledger.retireUnreserved(a.key, other, 'execute')).toThrow('recovery identity')
    expect(() => ledger.retireUnreserved(a.key, owner, 'refund')).toThrow('recovery identity')
    ledger.attachSignature(a.key, await operator.signTransaction(Transaction.from(a.unsigned)))
    expect(ledger.retireUnreserved(a.key, owner, 'execute')).toBe(false)
    const refundKey = id('existing refund'); ledger.reserveRefund(refundKey, owner, recipient, 100n, 90n, ledger.nextSequence(owner), backing(), 1n)
    expect(ledger.retireUnreserved(refundKey, owner, 'refund')).toBe(false)
    expect(() => ledger.retireUnreserved(refundKey, other, 'refund')).toThrow('recovery identity')
    store.db.prepare('DELETE FROM credit_attempts WHERE key=?').run(a.key)
    expect(() => ledger.retireUnreserved(a.key, owner, 'execute')).toThrow('recovery identity')
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
  })
  it('adds sequence columns without changing legacy holds and blocks old-binary insert shapes', () => {
    ledger.deposit(payment())
    const a = attempt(), refundKey = id('pre-upgrade refund')
    // Recreate the pre-upgrade column layout with existing, financially backed holds.
    for (const table of ['credit_attempts', 'credit_refunds']) store.db.exec(`
      DROP TRIGGER require_${table}_sequence;
      DROP TRIGGER immutable_${table}_sequence;
      ALTER TABLE ${table} DROP COLUMN sequence;`)
    store.db.prepare(`INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance)
      VALUES(?,?,?,?,?,?)`).run(a.key, owner, a.unsigned, String(a.maximumCharge), String(a.rate), String(a.collectionAllowance))
    store.db.prepare(`INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce,fee_expiration)
      VALUES(?,?,?,?,?,?,?,?)`).run(a.key, a.envelope, Date.now(), String(a.gasBudget), Date.now(),
      JSON.stringify({ kind: 'prepaid', ledgerId: ledger.id, owner }), a.nonce, a.expiration)
    store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created) VALUES(?,?,?,?,?,?)')
      .run(refundKey, owner, recipient, '100', '90', Date.now())
    const before = ledger.balance(owner)
    ledger = new CreditLedger(store, scope)
    expect(ledger.attempt(a.key)?.sequence).toBeNull()
    expect(ledger.refund(refundKey)?.sequence).toBeNull()
    expect(ledger.retireUnreserved(a.key, owner, 'execute')).toBe(false)
    expect(ledger.retireUnreserved(a.key, owner, 'execute', 1)).toBe(false)
    expect(ledger.retireUnreserved(refundKey, owner, 'refund')).toBe(false)
    ledger.reserveRefund(refundKey, owner, recipient, 100n, 90n, undefined as unknown as number, backing(), 1n)
    expect(ledger.balance(owner)).toEqual(before)
    expect(ledger.nextSequence(owner)).toBe(1)
    expect(() => store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created) VALUES(?,?,?,?,?,?)')
      .run(id('late old-binary refund'), owner, recipient, '100', '90', Date.now())).toThrow('sequence')
    expect(() => store.db.prepare('UPDATE credit_attempts SET sequence=1 WHERE key=?').run(a.key)).toThrow('immutable')
  })
  it('never reports absence from a restored journal awaiting review', () => {
    writeFileSync(join(root, '.prepaid-restore-review-required'), 'unreviewed restored archive', { mode: 0o600 })
    expect(() => ledger.retireUnreserved(id('missing'), owner, 'execute')).toThrow('recovery review')
    expect(store.db.prepare('SELECT * FROM credit_retired_requests').all()).toHaveLength(0)
    rmSync(join(root, '.prepaid-restore-review-required'))
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('creditRecoveryRequired', '1')
    expect(() => ledger.retireUnreserved(id('missing'), owner, 'refund')).toThrow('recovery review')
  })
  it('blocks a restored full archive before signing or reserving any refund', () => {
    ledger.deposit(payment())
    writeFileSync(join(root, '.prepaid-restore-review-required'), 'unreviewed restored archive', { mode: 0o600 })
    expect(() => ledger.reserve(attempt())).toThrow('recovery review')
    expect(() => ledger.reserveRefund(id('refund'), owner, recipient, 100n, 90n, ledger.nextSequence(owner), backing(), 1n)).toThrow('recovery review')
    expect(store.pending()).toHaveLength(0)
    expect(ledger.balance(owner).available).toBe(10n ** 18n)
  })
  it('credits a canonical leaf once and rejects reassignment or changed canonical evidence', () => {
    expect(ledger.deposit(payment())).toBe(true)
    expect(ledger.deposit(payment())).toBe(false)
    expect(ledger.balance(owner).available).toBe(10n ** 18n)
    for (const changed of [{ owner: other }, { amount: 2n }, { commitment: id('different note') },
      { blockHash: id('reorg') }, { blockNumber: 11 }, { transactionHash: id('copy') }])
      expect(() => ledger.deposit({ ...payment(), ...changed })).toThrow('different details')
    expect(ledger.balance(other).available).toBe(0n)
    expect(() => store.db.exec('DELETE FROM credit_deposits')).toThrow('immutable')
  })
  it('credits identical note hashes at distinct leaf positions and trees independently across restart', () => {
    const first = payment(10n), second = { ...first, position: 1 }, third = { ...first, tree: 1 }
    for (const leaf of [first, second, third]) { ledger.deposit(leaf); ledger.deposit(leaf) }
    expect(ledger.balance(owner).available).toBe(30n)
    expect(ledger.liability()).toBe(30n)
    store.close(); store = new Store(root); ledger = new CreditLedger(store, scope)
    for (const leaf of [first, second, third]) ledger.deposit(leaf)
    expect(ledger.balance(owner).available).toBe(30n)
    expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_deposits').get()?.count).toBe(3)
    expect(() => ledger.deposit({ ...second, owner: other })).toThrow('different details')
    expect(() => ledger.deposit({ ...second, commitment: id('replacement') })).toThrow('different details')
  })
  it('rejects malformed canonical leaf coordinates without crediting a balance', () => {
    for (const changed of [{ tree: -1 }, { tree: 0.5 }, { tree: Number.MAX_SAFE_INTEGER + 1 },
      { position: -1 }, { position: 0.5 }, { position: 2 ** 16 }, { position: NaN }])
      expect(() => ledger.deposit({ ...payment(), ...changed })).toThrow('leaf position')
    expect(ledger.balance(owner).available).toBe(0n)
  })
  it('binds the ledger identity to chain, operator, fee recipient and token', () => {
    const identity = ledger.id
    expect(new CreditLedger(store, scope).id).toBe(identity)
    for (const changed of [{ chainId: CHAIN_ID === 1 ? 56 : 1 }, { operator: other }, { recipient: '0zk1different' }, { token: other }])
      expect(() => new CreditLedger(store, { ...scope, ...changed })).toThrow()
    expect(() => store.db.exec('DELETE FROM credit_identity')).toThrow('immutable')
  })
  it('reserves credit and nonce before signing and retains both through restart', () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    expect(store.get(a.key)?.raw).toBeNull()
    expect(store.hasPending()).toBe(true)
    expect(store.nonceBlocked(0)).toBe(true)
    expect(ledger.balance(owner).reserved).toBe(a.maximumCharge)
    const identity = ledger.id
    store.close(); store = new Store(root); ledger = new CreditLedger(store, scope)
    expect(ledger.id).toBe(identity)
    expect(store.hasPending()).toBe(true)
    expect(ledger.balance(owner).reserved).toBe(a.maximumCharge)
    expect(() => ledger.reserve(a)).toThrow('already reserved')
  })
  it('cannot spend another owner’s credit, unconfirmed funding, or a refund hold', () => {
    expect(() => ledger.reserve(attempt())).toThrow('backing changed')
    expect(store.get(id('attempt'))).toBeUndefined()
    ledger.deposit({ ...payment(), owner: other })
    expect(() => ledger.reserve(attempt())).toThrow('insufficient')
    ledger.deposit(payment(100n, 'owned'))
    ledger.reserveRefund(id('refund'), owner, recipient, 100n, 90n, ledger.nextSequence(owner), backing(), 1n)
    expect(ledger.balance(owner).available).toBe(0n)
    expect(() => ledger.reserve(attempt())).toThrow('insufficient')
  })
  it('serializes reservations across two connections and rolls back failed reservations', () => {
    ledger.deposit(payment()); const secondStore = new Store(root)
    try {
      const second = new CreditLedger(secondStore, scope)
      ledger.reserve(attempt())
      expect(() => second.reserve(attempt({ key: id('second') }))).toThrow('existing operator reservation')
      expect(second.attempt(id('second'))).toBeUndefined()
      expect(secondStore.get(id('second'))).toBeUndefined()
    } finally { secondStore.close() }
  })
  it('attaches only the exact reserved transaction and accepts identical attachment retries', async () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    const tx = Transaction.from(a.unsigned), raw = await operator.signTransaction(tx)
    expect(ledger.attachSignature(a.key, raw)).toBe(Transaction.from(raw).hash)
    expect(ledger.attachSignature(a.key, raw)).toBe(Transaction.from(raw).hash)
    expect(() => ledger.attachSignature(a.key, a.unsigned)).toThrow('signature')
    const different = await operator.signTransaction({ ...tx.toJSON(), gasLimit: 99_999n })
    expect(() => ledger.attachSignature(a.key, different)).toThrow('differs')
  })
  it('settles a confirmed attempt once and restores unused reserved credit', async () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    const raw = await operator.signTransaction(Transaction.from(a.unsigned)), hash = ledger.attachSignature(a.key, raw)
    const receipt = { hash, gasUsed: 50_000n, gasPrice: 100n, status: 0, blockNumber: 10, blockHash: id('final') } as TransactionReceipt
    expect(() => ledger.settle(a.key, receipt)).toThrow('verified finalized')
    const actualCost = 5_000_000n
    store.confirmed(a.key, a.gasBudget, Date.now())
    expect(() => ledger.settle(a.key, receipt)).toThrow('verified finalized')
    const provider = { getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 10, hash: id('final'), timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider
    await finalizedCreditReceipt(provider, hash)
    const charge = creditCharge(actualCost, a.rate, a.collectionAllowance)
    expect(ledger.settle(a.key, receipt)).toBe(charge)
    expect(ledger.settle(a.key, receipt)).toBe(charge)
    expect(store.get(a.key)?.actual_cost).toBe(actualCost.toString())
    expect(ledger.balance(owner)).toEqual({ deposited: 10n ** 18n, charged: charge, reserved: 0n, refunds: 0n, available: 10n ** 18n - charge })
    expect(store.hasPending()).toBe(false)
    expect(() => ledger.settle(a.key, { ...receipt } as TransactionReceipt)).toThrow('verified finalized')
  })
  it('bounds cancellation liability and keeps unknown holds after quote expiry', () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    expect(() => ledger.assertCancellationCovered(a.key, a.gasBudget)).not.toThrow()
    expect(() => ledger.assertCancellationCovered(a.key, a.gasBudget + 1n)).toThrow('secured prepaid budget')
    store.db.prepare('UPDATE requests SET fee_expiration=0 WHERE key=?').run(a.key)
    expect(ledger.balance(owner).reserved).toBe(a.maximumCharge)
    expect(store.hasPending()).toBe(true)
  })
  it('keeps refund requests idempotent and requires finalized matching refund evidence', async () => {
    ledger.deposit(payment(100n)); const key = id('refund')
    ledger.reserveRefund(key, owner, recipient, 70n, 60n, ledger.nextSequence(owner), backing(), 1n)
    ledger.reserveRefund(key, owner, recipient, 70n, 60n, ledger.nextSequence(owner), backing(), 1n)
    expect(ledger.balance(owner).available).toBe(30n)
    expect(() => ledger.reserveRefund(key, other, recipient, 70n, 60n, ledger.nextSequence(other), backing(), 1n)).toThrow('identity changed')
    const receipt = { hash: id('refund transaction'), blockNumber: 10, blockHash: id('refund block'), status: 1,
      gasUsed: 21_000n, gasPrice: 1n } as TransactionReceipt
    const refund = { receipt, commitment: id('refund note'), recipient, amount: 60n, token: scope.token,
      memo: creditRefundMemo(scope, ledger.id, key), ...refundEvidence(receipt, 60n) }
    expect(() => ledger.settleRefund(key, refund)).toThrow('verified finalized')
    await finalizedCreditReceipt({ getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 10, hash: receipt.blockHash, timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider, receipt.hash)
    expect(() => ledger.settleRefund(key, refund)).toThrow('Missing')
    prepareRefund(key); ledger.recordRefundPayout(key, receipt)
    expect(() => ledger.settleRefund(key, { ...refund, amount: 61n })).toThrow('Missing')
    expect(() => ledger.settleRefund(key, { ...refund, memo: 'copied receipt' })).toThrow('Missing')
    ledger.settleRefund(key, refund)
    ledger.settleRefund(key, refund)
    expect(ledger.balance(owner).available).toBe(30n)
    ledger.reserveRefund(id('refund2'), owner, recipient, 30n, 20n, ledger.nextSequence(owner), backing(), 1n)
    prepareRefund(id('refund2'))
    expect(() => ledger.recordRefundPayout(id('refund2'), receipt)).toThrow('immutable')
    expect(() => ledger.reserveRefund(id('invalid recipient'), owner, '0zk1broken', 1n, 1n, ledger.nextSequence(owner), backing(), 1n)).toThrow('Invalid credit refund')
  })
  it('requires an explicit local owner assignment for a memo-less payout and never uses the same note twice', async () => {
    ledger.deposit(payment(200n))
    const key = id('owner refund'), second = id('second owner refund')
    ledger.reserveRefund(key, owner, recipient, 100n, 90n, ledger.nextSequence(owner), backing(), 1n)
    const receipt = { hash: id('anon payout'), blockNumber: 10, blockHash: id('owner refund block'), status: 1,
      gasUsed: 100_000n, gasPrice: 1n } as TransactionReceipt
    const proof = { receipt, commitment: id('anon payout note'), recipient, token: scope.token, amount: 90n, memo: undefined, ...refundEvidence(receipt, 90n) }
    expect(() => ledger.recordRefundPayout(key, receipt)).toThrow('verified finalized')
    await finalizedCreditReceipt({ getNetwork: async () => ({ chainId: CHAIN }), getTransactionReceipt: async () => receipt,
      getBlock: async () => ({ number: 10, hash: receipt.blockHash, timestamp: 1234567890 }),
    } as unknown as JsonRpcProvider, receipt.hash)
    expect(() => ledger.settleRefund(key, proof)).toThrow('Missing')
    prepareRefund(key); ledger.recordRefundPayout(key, receipt); ledger.recordRefundPayout(key, receipt)
    expect(ledger.refundPayouts(key)).toHaveLength(1)
    expect(ledger.liability()).toBe(200n)
    expect(() => ledger.settleRefund(key, { ...proof, amount: 91n })).toThrow('Missing')
    expect(() => ledger.settleRefund(key, { ...proof, token: other })).toThrow('Missing')
    expect(() => ledger.settleRefund(key, { ...proof, memo: creditRefundMemo(scope, ledger.id, second) })).toThrow('Missing')
    expect(() => store.db.exec('DELETE FROM credit_refund_payouts')).toThrow('immutable')
    ledger.settleRefund(key, proof); ledger.settleRefund(key, proof)
    expect(ledger.liability()).toBe(100n)
    ledger.reserveRefund(second, owner, recipient, 100n, 90n, ledger.nextSequence(owner), backing(), 1n)
    prepareRefund(second)
    expect(() => ledger.recordRefundPayout(second, receipt)).toThrow('immutable')
    expect(ledger.refund(second)?.transaction_hash).toBeNull()
    expect(ledger.balance(owner).available).toBe(0n)
  })
  it('uses integer rounding and rejects underfunded caps and malformed quantities', () => {
    expect(creditCharge(1n, 115n * 10n ** 16n, 0n)).toBe(2n)
    expect(creditCharge(9_007_199_254_740_993n, 10n ** 18n, 0n)).toBe(9_007_199_254_740_993n)
    for (const changed of [{ maximumCharge: 1n }, { rate: 0n }, { collectionAllowance: -1n }, { gasBudget: 1n }, { expiration: 0 }])
      expect(() => ledger.reserve(attempt(changed))).toThrow()
    expect(() => ledger.deposit(payment(-1n))).toThrow('quantity')
    expect(() => ledger.deposit(payment(2n ** 256n))).toThrow('quantity')
  })
  it('rejects missing nonce history, restored credit balances and unaccounted blob fees before reservation', () => {
    ledger.deposit(payment())
    expect(() => ledger.assertChainNonce(1)).toThrow('missing journal')
    const a = attempt(), original = Transaction.from(a.unsigned)
    const blob = Transaction.from({ ...original.toJSON(), type: 3, maxFeePerBlobGas: 1n, blobVersionedHashes: [`0x01${'11'.repeat(31)}`] })
    expect(() => ledger.reserve({ ...a, unsigned: blob.unsignedSerialized })).toThrow('Invalid prepaid attempt')
    store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('creditRecoveryRequired', '1')
    expect(() => ledger.reserve(a)).toThrow('recovery review')
    expect(() => ledger.reserveRefund(id('refund'), owner, recipient, 1n, 1n, ledger.nextSequence(owner), backing(), 1n)).toThrow('recovery review')
    expect(ledger.balance(owner).available).toBe(10n ** 18n)
  })
  it('holds the full credit and gas exposure until finality without blocking the next mined nonce', async () => {
    ledger.deposit(payment()); const a = attempt(); ledger.reserve(a)
    const hash = ledger.attachSignature(a.key, await operator.signTransaction(Transaction.from(a.unsigned)))
    ledger.observeInclusion(a.key, { hash, blockHash: id('included'), blockNumber: 9, gasUsed: 50_000n, gasPrice: 100n } as TransactionReceipt)
    expect(store.hasPending()).toBe(false)
    expect(store.pending()).toHaveLength(1)
    expect(ledger.balance(owner).reserved).toBe(a.maximumCharge)
    expect(store.exposure(Date.now() + 25 * 60 * 60_000)).toBe(a.gasBudget)
    expect(store.nonceBlocked(0)).toBe(true)
    expect(store.nonceBlocked(1)).toBe(false)
    expect(() => ledger.assertChainNonce(1)).not.toThrow()
  })
})


describe('explicit prepaid withdrawal pilot scope', () => {
  it('preserves the old consumed marker and requires the exact approved ledger before reservation', () => {
    ledger.deposit(payment())
    store.db.prepare('INSERT INTO settings VALUES(?,?)').run('withdrawalPilot', 'historic-withdrawal')
    expect(() => ledger.reserve(attempt({ withdrawalPilot: true }))).toThrow('pilot')
    expect(() => ledger.reserve(attempt({ withdrawalPilot: true, prepaidPilotLedgerId: id('wrong ledger') }))).toThrow('approval')
    expect(store.pending()).toEqual([])
    const row = attempt({ withdrawalPilot: true, prepaidPilotLedgerId: ledger.id })
    ledger.reserve(row)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historic-withdrawal')
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get(`prepaidWithdrawalPilot:${ledger.id}`)?.value).toBe(row.key)
    expect(() => ledger.reserve(row)).toThrow()
    const savedId = ledger.id
    store.close(); store = new Store(root); ledger = new CreditLedger(store, scope)
    expect(ledger.id).toBe(savedId)
    expect(() => ledger.reserve(attempt({ key: id('second scoped attempt'), withdrawalPilot: true,
      prepaidPilotLedgerId: ledger.id }))).toThrow('pilot')
    expect(store.pending()).toHaveLength(1)
    expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('withdrawalPilot')?.value).toBe('historic-withdrawal')
  })
})
