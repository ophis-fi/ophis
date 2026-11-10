import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { id, Transaction, Wallet } from 'ethers'
import { CreditLedger, creditCharge } from '../src/credit'
import { creditBackingEvidence, verifyCreditBacking } from '../src/credit-backing'
import { ownerDebitEvidence, verifyUnrelatedOwnerPayout } from '../src/credit-owner-payment'
import { finalizedCreditReceipt } from '../src/credit-payment'
import { accountingReport } from '../src/operations'
import { Store } from '../src/storage'
import { CHAIN, CHAIN_ID, TOKENS } from '../src/config'
import { chainFixture, syntheticNote, feeAddress, provenance, ownerEvidence, receiptFor } from './credit-owner.fixture'

// Ledger tests supply an already verified native result. The independent native-verifier suite exercises its opaque brand and trace checks.
vi.mock('../src/anon-native-collection', () => ({ ANON_COLLECTION_BASE_FEE_BPS: 13n, nativeCollectionEvidence: (proof: unknown) => proof }))
const owner = Wallet.createRandom().address, operator = Wallet.createRandom()
const policy = { inputLimit: 2, outputLimit: 4, proofLimit: 2, marginBps: 1500n }
const refundRecipient = '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm'
let directory: string, store: Store, ledger: CreditLedger, chain: ReturnType<typeof chainFixture>
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-credit-owner-')); store = new Store(directory)
  ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator: operator.address, recipient: feeAddress, token: TOKENS[0].address })
  chain = chainFixture()
})
afterEach(() => { vi.restoreAllMocks(); store.close(); rmSync(directory, { recursive: true, force: true }) })
function deposit(amount = 1000n, position = 0, tree = 0) {
  const note = syntheticNote(amount, position, 10, tree); chain.add(note)
  ledger.deposit({ ...provenance(note), owner, amount })
  return note
}
function earned(charge = 300n, gas = 100n, label = 'first') {
  const key = id(`earned-${label}`), sequence = ledger.nextSequence(owner)
  const unsigned = Transaction.from({ chainId: CHAIN, type: 2, to: owner, nonce: sequence - 1,
    gasLimit: gas, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  if (sequence === 1) store.db.prepare('INSERT INTO credit_owner_sequences(owner,sequence) VALUES(?,1)').run(owner)
  else store.db.prepare('UPDATE credit_owner_sequences SET sequence=sequence+1 WHERE owner=?').run(owner)
  store.db.prepare('INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,charged,settlement_hash,sequence) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(key, owner, unsigned, charge.toString(), '1000000000000000000', '0', charge.toString(), id(`receipt-${label}`), sequence)
  store.db.prepare('INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce,confirmed,assured,actual_cost) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(key, 'synthetic', Date.now(), gas.toString(), Date.now(), JSON.stringify({ kind: 'prepaid', owner, ledgerId: ledger.id,
      charged: charge.toString(), receiptHash: id(`receipt-${label}`) }),
      sequence - 1, 1, 1, gas.toString())
}
async function prepare(input: Parameters<CreditLedger['prepareOwnerOperation']>[0]) {
  const backing = await verifyCreditBacking(chain.provider, [...chain.notes.values()], ledger.accountedNotes(), 2)
  return ledger.prepareOwnerOperation({ collectionFees: { unshieldFeeBps: 25n, gatewayFeeBps: 13n }, ...input }, backing)
}

async function collection(input: ReturnType<typeof deposit>, debit = 300n, fee = 10n, untouched: ReturnType<typeof deposit>[] = [], label = 'first') {
  const transactionHash = id(`collection-${label}`), output = syntheticNote(input.note.value - debit, 100 + input.position, 20, input.tree, transactionHash)
  const receipt = receiptFor(transactionHash, 20, [output], [input])
  const evidence = await ownerEvidence(chain, ledger, [input], [output], receipt, untouched)
  const native = { transactionHash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber,
    grossUnshield: debit - fee, nativeReceived: debit - fee - 1n, recipient: operator.address } as any
  return { ...evidence, native, output }
}

it('requires a durable owner intent before payout association and holds it across restart, including unknown outcomes', async () => {
  deposit(); earned()
  const receipt = receiptFor(id('candidate'), 20, [])
  chain.receipts.set(receipt.hash, receipt)
  const verified = await finalizedCreditReceipt(chain.provider, receipt.hash)
  expect(() => ledger.recordOwnerPayout(id('missing'), verified)).toThrow('saved unpaid')
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  expect(() => ledger.assertOwnerJournalReady()).toThrow('saved owner payment')
  ledger.recordOwnerPayout(intent.key, verified)
  store.close(); store = new Store(directory); ledger = CreditLedger.load(store)
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
  expect(ledger.earned()).toBe(300n)
  expect(() => ledger.assertOwnerJournalReady()).toThrow('saved owner payment')
  expect(() => store.db.prepare('DELETE FROM credit_owner_intents').run()).toThrow('immutable')
  expect(() => store.db.prepare('UPDATE credit_owner_candidates SET block_hash=?').run(id('reorg'))).toThrow('immutable')
  const changed = { ...verified, blockHash: id('reorg') }
  expect(() => ledger.recordOwnerPayout(intent.key, changed as any)).toThrow('verified finalized')
})

it('fully collects earned value including exact private cost, retains liability, and does not collect lifetime earnings twice', async () => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const payment = await collection(input)
  ledger.recordOwnerPayout(intent.key, payment.receipt); ledger.settleOwnerCollection(intent.key, payment)
  expect(ledger.earned()).toBe(0n); expect(ledger.liability()).toBe(700n)
  expect(ledger.pendingOwnerIntent()).toBeUndefined()
  expect(ledger.accountedNotes()).toContainEqual(provenance(payment.output))
  expect(() => ledger.deposit({ ...provenance(payment.output), owner, amount: payment.output.note.value })).toThrow('owner change')
  expect(() => ledger.settleOwnerCollection(intent.key, payment)).toThrow('full-earned')
  await expect(prepare({ ...policy, kind: 'collection', maximumPrivateFee: 0n, minimumNative: 1n })).rejects.toThrow('all positive')
  earned(100n, 30n, 'second')
  const next = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 4n, minimumNative: 90n })
  const second = await collection(payment.output, 100n, 4n, [], 'second')
  ledger.recordOwnerPayout(next.key, second.receipt); ledger.settleOwnerCollection(next.key, second)
  expect(ledger.earned()).toBe(0n); expect(ledger.liability()).toBe(600n)
  expect(accountingReport(store.db).prepaidCredit).toMatchObject({ remainingEarned: '0', ownerPrivateFees: '14', collectedGross: '386', nativeCollected: '384' })
})

it.each([{ debit: 250n, fee: 10n, label: 'partial' }, { debit: 300n, fee: 11n, label: 'overrun' }])('retains the hold for $label collection', async ({ debit, fee }) => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 200n })
  const payment = await collection(input, debit, fee)
  ledger.recordOwnerPayout(intent.key, payment.receipt)
  expect(() => ledger.settleOwnerCollection(intent.key, payment)).toThrow()
  expect(ledger.earned()).toBe(300n); expect(ledger.liability()).toBe(700n)
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
})

it('allows prior earned recovery without consolidating fragmented customer liabilities', async () => {
  const input = deposit(); earned()
  const dust = Array.from({ length: 20 }, (_, i) => deposit(1n, i + 1))
  const backing = await verifyCreditBacking(chain.provider, [input, ...dust], ledger.accountedNotes(), 2)
  expect(creditBackingEvidence(backing).bounded).toBe(1000n)
  expect(creditBackingEvidence(backing).bounded >= ledger.liability()).toBe(true)
  expect(creditBackingEvidence(backing).bounded < ledger.requiredBacking()).toBe(true)
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const payment = await collection(input, 300n, 10n, dust)
  ledger.recordOwnerPayout(intent.key, payment.receipt); ledger.settleOwnerCollection(intent.key, payment)
  expect(ledger.earned()).toBe(0n); expect(ledger.liability()).toBe(720n)
  expect(creditBackingEvidence(payment.backing).available).toBe(720n)
  expect(creditBackingEvidence(payment.backing).bounded).toBe(700n)
})

it('admits three ordinary deposits while bounding every new maximum charge by collectible notes', async () => {
  const notes = [deposit(1_000_000n, 0), deposit(1_000_000n, 1), deposit(1_000_000n, 2)]
  const backing = await verifyCreditBacking(chain.provider, notes, ledger.accountedNotes(), 2)
  expect(creditBackingEvidence(backing).available).toBe(3_000_000n)
  expect(creditBackingEvidence(backing).bounded).toBe(1_000_000n)
  const gasBudget = 21_000n, maximumCharge = 25_000n
  const unsigned = Transaction.from({ chainId: CHAIN, type: 2, to: owner, nonce: 0,
    gasLimit: gasBudget, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  ledger.reserve({ key: id('three-deposits'), owner, sequence: 1, envelope: 'synthetic', unsigned, nonce: 0,
    gasBudget, rate: 10n ** 18n, collectionAllowance: 0n, maximumCharge, expiration: Date.now() + 60_000,
    dailyBudget: gasBudget, backing })
  expect(ledger.maximumPendingCharges()).toBe(maximumCharge)
  expect(ledger.requiredBacking()).toBe(3_000_000n)
})

it('refuses a large future charge backed by many tiny notes when it would strand existing earned reimbursement', async () => {
  const largest = deposit(1000n); earned(800n, 300n)
  const dust = Array.from({ length: 40 }, (_, index) => deposit(10n, index + 1))
  const backing = await verifyCreditBacking(chain.provider, [largest, ...dust], ledger.accountedNotes(), 2)
  expect(creditBackingEvidence(backing).available).toBe(1400n)
  expect(creditBackingEvidence(backing).bounded).toBe(1000n)
  expect(ledger.balance(owner).available).toBe(600n)
  const gasBudget = 300n, unsigned = Transaction.from({ chainId: CHAIN, type: 2, to: owner, nonce: 1,
    gasLimit: gasBudget, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  expect(() => ledger.reserve({ key: id('dust-funded-large-charge'), owner, sequence: ledger.nextSequence(owner), envelope: 'synthetic',
    unsigned, nonce: 1, gasBudget, rate: 10n ** 18n, collectionAllowance: 0n, maximumCharge: 300n,
    expiration: Date.now() + 60_000, dailyBudget: 1000n, backing })).toThrow('backing changed')
  expect(ledger.earned()).toBe(800n)
  expect(ledger.maximumPendingCharges()).toBe(0n)
})

it('rejects an oversized refund before any hold, and reserves bounded capacity for every queued refund', async () => {
  const secondOwner = Wallet.createRandom().address, thirdOwner = Wallet.createRandom().address
  const notes = [owner, secondOwner, thirdOwner].map((claimant, position) => {
    const note = syntheticNote(100n, position); chain.add(note)
    ledger.deposit({ ...provenance(note), owner: claimant, amount: 100n }); return note
  })
  const backing = await verifyCreditBacking(chain.provider, notes, ledger.accountedNotes(), 2)
  expect(() => ledger.reserveRefund(id('too-large'), owner, refundRecipient, 300n, 280n, 1, backing, 1n)).toThrow('smaller partial refund')
  expect(ledger.refund(id('too-large'))).toBeUndefined()
  expect(ledger.nextSequence(owner)).toBe(1)
  ledger.reserveRefund(id('first-queued'), owner, refundRecipient, 49n, 40n, 1, backing, 1n)
  expect(() => ledger.reserveRefund(id('duplicate-owner'), owner, refundRecipient, 10n, 5n, 2, backing, 1n)).toThrow('pending refund')
  ledger.reserveRefund(id('second-queued'), secondOwner, refundRecipient, 49n, 40n, 1, backing, 1n)
  expect(ledger.pendingRefundGross()).toBe(98n)
  expect(() => ledger.reserveRefund(id('capacity-exhausted'), thirdOwner, refundRecipient, 3n, 2n, 1, backing, 1n)).toThrow('smaller partial refund')
  expect(ledger.nextSequence(owner)).toBe(2)
  const unsigned = Transaction.from({ chainId: CHAIN, type: 2, to: owner, nonce: 0,
    gasLimit: 3n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  expect(() => ledger.reserve({ key: id('must-preserve-refunds'), owner, sequence: 2, envelope: 'synthetic', unsigned,
    nonce: 0, gasBudget: 3n, rate: 10n ** 18n, collectionAllowance: 0n, maximumCharge: 3n,
    expiration: Date.now() + 60_000, dailyBudget: 3n, backing })).toThrow('backing changed')
})

it.each([1n, 99n, 100n])('retains execution headroom only for another customer with an affordable attempt: %s', async (otherCredit) => {
  const input = deposit(), otherOwner = Wallet.createRandom().address, otherNote = syntheticNote(otherCredit, 1)
  chain.add(otherNote); ledger.deposit({ ...provenance(otherNote), owner: otherOwner, amount: otherCredit })
  const backing = await verifyCreditBacking(chain.provider, [input, otherNote], ledger.accountedNotes(), 2)
  const headroom = otherCredit >= 100n ? 100n : 0n
  expect(ledger.refundExecutionHeadroom(owner, 100n)).toBe(headroom)
  const maximum = 1000n - headroom
  if (headroom) expect(() => ledger.reserveRefund(id('starve-other-owner'), owner, refundRecipient, maximum + 1n,
    maximum - 9n, 1, backing, 100n)).toThrow('smaller partial refund')
  ledger.reserveRefund(id('safe-partial-or-full-exit'), owner, refundRecipient, maximum, maximum - 10n, 1, backing, 100n)
  expect(ledger.pendingRefundGross()).toBe(maximum)
  expect(ledger.balance(otherOwner).available).toBe(otherCredit)
})

it('computes refund headroom exactly above the safe-integer range with no per-owner balance queries', () => {
  deposit()
  const otherOwner = Wallet.createRandom().address, amount = 2n ** 53n + 1n, note = syntheticNote(amount, 1)
  chain.add(note); ledger.deposit({ ...provenance(note), owner: otherOwner, amount })
  store.db.prepare('INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,charged,settlement_hash,sequence) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id('headroom-actual-charge'), otherOwner, 'fixture', '10', '1000000000000000000', '0', '1', id('charge-receipt'), 1)
  store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created,sequence) VALUES(?,?,?,?,?,?,?)')
    .run(id('headroom-refund'), otherOwner, refundRecipient, '1', '1', Date.now(), 2)
  vi.spyOn(ledger, 'balance').mockImplementation(() => { throw new Error('No per-owner query is allowed in the aggregation.') })
  expect(ledger.refundExecutionHeadroom(owner, 2n ** 53n)).toBe(0n)
  expect(ledger.refundExecutionHeadroom(owner, 2n ** 53n - 1n)).toBe(2n ** 53n - 1n)
})

it('rejects a claim race atomically before an operator reservation', async () => {
  const input = deposit(1_000_000n)
  const backing = await verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)
  deposit(1n, 1)
  const gasBudget = 21_000n, rate = 115n * 10n ** 16n
  const transaction = Transaction.from({ chainId: CHAIN, type: 2, to: Wallet.createRandom().address, nonce: 0,
    gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })
  expect(() => ledger.reserve({ key: id('claim-race'), owner, sequence: ledger.nextSequence(owner), envelope: 'synthetic',
    unsigned: transaction.unsignedSerialized, nonce: 0, gasBudget, rate, collectionAllowance: 0n,
    maximumCharge: creditCharge(gasBudget, rate, 0n), expiration: Date.now() + 60_000, dailyBudget: gasBudget, backing })).toThrow('backing changed')
  expect(store.db.prepare('SELECT 1 FROM requests').get()).toBeUndefined()
})

it('requires canonical backing evidence at both reservation boundaries, including untyped callers', () => {
  deposit(1_000_000n)
  expect(() => ledger.reserveRefund(id('missing-refund-proof'), owner, refundRecipient, 100n, 90n, 1, undefined as any, 1n))
    .toThrow('Fresh canonical')
  const unsigned = Transaction.from({ chainId: CHAIN, type: 2, to: owner, nonce: 0,
    gasLimit: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized
  expect(() => ledger.reserve({ key: id('missing-execution-proof'), owner, sequence: 1, envelope: 'synthetic', unsigned, nonce: 0,
    gasBudget: 21_000n, rate: 10n ** 18n, collectionAllowance: 0n, maximumCharge: 21_000n,
    expiration: Date.now() + 60_000, dailyBudget: 21_000n, backing: undefined as any })).toThrow('Fresh canonical')
  expect(ledger.nextSequence(owner)).toBe(1)
  expect(ledger.pendingRefundGross()).toBe(0n)
  expect(store.db.prepare('SELECT 1 FROM requests').get()).toBeUndefined()
})

it('never values unclaimed donations or an identical commitment at another position as accounted collateral', async () => {
  const input = deposit(10n), donation = syntheticNote(1_000_000n, 1)
  const duplicate = { ...input, position: 2, nullifier: id('duplicated-hash-nullifier') }
  const backing = await verifyCreditBacking(chain.provider, [input, donation, duplicate], ledger.accountedNotes(), 2)
  expect(creditBackingEvidence(backing)).toMatchObject({ available: 10n, bounded: 10n })
  const wrongTree = { ...input, tree: 1 }
  expect(creditBackingEvidence(await verifyCreditBacking(chain.provider, [wrongTree], ledger.accountedNotes(), 2)).available).toBe(0n)
})

it('measures exact fee-wallet input minus owned change rather than a balance delta masked by another deposit', async () => {
  const input = deposit(), unrelated = deposit(500n, 1)
  const payment = await collection(input, 300n, 10n, [unrelated])
  expect(ownerDebitEvidence(payment.debit).debit).toBe(300n)
  expect(creditBackingEvidence(payment.backing).available).toBe(1200n)
  const fake = { kind: 'verified-owner-debit' } as const
  expect(() => ownerDebitEvidence(fake)).toThrow('Canonical')
})

it('rejects mixed unclaimed inputs and change splitting that could invalidate bounded recovery', async () => {
  const input = deposit(), donation = syntheticNote(1000n, 1)
  chain.add(donation)
  const hash = id('unsupported-owner-payment'), output = syntheticNote(1700n, 100, 20, 0, hash)
  await expect(ownerEvidence(chain, ledger, [input, donation], [output], receiptFor(hash, 20, [output], [input, donation])))
    .rejects.toThrow('Unclaimed')
  const left = syntheticNote(500n, 101, 20, 0, hash), right = syntheticNote(499n, 102, 20, 0, hash)
  await expect(ownerEvidence(chain, ledger, [input], [left, right], receiptFor(hash, 20, [left, right], [input])))
    .rejects.toThrow('single-change')
})

it('never joins separate input trees when bounding recovery capacity', async () => {
  const left = deposit(10n), right = deposit(11n, 1, 1)
  expect(creditBackingEvidence(await verifyCreditBacking(chain.provider, [left, right], ledger.accountedNotes(), 2)).bounded).toBe(11n)
})

it('rejects a spent mapping during a cold backing scan', async () => {
  const input = deposit()
  vi.spyOn(chain.provider, 'call').mockResolvedValueOnce('0x' + '0'.repeat(63) + '1')
  await expect(verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)).rejects.toThrow('missing')
})

it('rejects a changed canonical origin during a cold backing scan', async () => {
  const input = deposit()
  const old = chain.provider.getBlock.bind(chain.provider)
  vi.spyOn(chain.provider, 'getBlock').mockImplementation(async (tag) => tag === 10 ? ({ ...await old(tag), hash: id('reorg') } as any) : old(tag))
  await expect(verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)).rejects.toThrow('reorganized')
})

it('settles a refund-only deposit with the exact private payout fee, preserving the later collectible remainder', async () => {
  const input = deposit(), key = id('refund-only-owner')
  const backing = await verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)
  expect(() => ledger.reserveRefund(key, owner, feeAddress, 300n, 250n, 1, backing, 1n)).toThrow('Invalid credit refund')
  ledger.reserveRefund(key, owner, refundRecipient, 300n, 250n, 1, backing, 1n)
  const intent = await prepare({ ...policy, kind: 'refund', refundKey: key, maximumPrivateFee: 20n, minimumNative: 0n })
  const payment = await collection(input, 260n, 10n)
  ledger.recordRefundPayout(key, payment.receipt)
  ledger.settleRefund(key, { ...payment, commitment: id('verified-private-refund-output'), recipient: refundRecipient,
    amount: 250n, token: TOKENS[0].address, memo: undefined })
  expect(ledger.earned()).toBe(40n); expect(ledger.liability()).toBe(700n)
  expect(accountingReport(store.db).prepaidCredit).toMatchObject({ refundFees: '50', ownerPrivateFees: '10', remainingEarned: '40' })
  expect(ledger.pendingOwnerIntent()).toBeUndefined()
  expect(ledger.ownerPayouts(intent.key)).toHaveLength(1)
  const next = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 4n, minimumNative: 30n })
  const recovery = await collection(payment.output, 40n, 4n, [], 'refund-fee')
  ledger.recordOwnerPayout(next.key, recovery.receipt); ledger.settleOwnerCollection(next.key, recovery)
  expect(ledger.earned()).toBe(0n); expect(ledger.liability()).toBe(700n)
})

it('does not reimburse already-deducted private fees twice when collecting a refund-only remainder', async () => {
  const input = deposit(), key = id('private-fees-already-paid')
  const backing = await verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)
  ledger.reserveRefund(key, owner, refundRecipient, 200n, 100n, 1, backing, 1n)
  await prepare({ ...policy, kind: 'refund', refundKey: key, maximumPrivateFee: 80n, minimumNative: 0n })
  const paid = await collection(input, 180n, 80n)
  ledger.recordRefundPayout(key, paid.receipt)
  ledger.settleRefund(key, { ...paid, commitment: id('private-fee-refund-output'), recipient: refundRecipient,
    amount: 100n, token: TOKENS[0].address, memo: undefined })
  expect(ledger.earned()).toBe(20n)
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 1n, minimumNative: 13n })
  const recovery = await collection(paid.output, 20n, 1n, [], 'affordable-refund-only')
  ledger.recordOwnerPayout(intent.key, recovery.receipt); ledger.settleOwnerCollection(intent.key, recovery)
  expect(ledger.earned()).toBe(0n)
  expect(ledger.liability()).toBe(800n)
  expect(recovery.native.nativeReceived).toBe(18n)
})

it('keeps recovery capacity in one note even when owner change rolls into another Merkle tree', async () => {
  const input = deposit(600n, 0), other = deposit(400n, 1)
  const backing = await verifyCreditBacking(chain.provider, [input, other], ledger.accountedNotes(), 2)
  expect(creditBackingEvidence(backing)).toMatchObject({ available: 1000n, bounded: 600n })
  expect(() => ledger.reserveRefund(id('unsafe-rollover-obligation'), owner, refundRecipient, 700n, 650n, 1, backing, 1n))
    .toThrow('smaller partial refund')
  const key = id('rollover-refund')
  ledger.reserveRefund(key, owner, refundRecipient, 500n, 400n, 1, backing, 1n)
  await prepare({ ...policy, kind: 'refund', refundKey: key, maximumPrivateFee: 0n, minimumNative: 0n })
  const hash = id('rollover-payout'), change = syntheticNote(200n, 0, 20, 1, hash)
  const payment = await ownerEvidence(chain, ledger, [input], [change], receiptFor(hash, 20, [change], [input]), [other])
  ledger.recordRefundPayout(key, payment.receipt)
  ledger.settleRefund(key, { ...payment, commitment: id('rollover-refund-output'), recipient: refundRecipient,
    amount: 400n, token: TOKENS[0].address, memo: undefined })
  expect(ledger.earned()).toBe(100n)
  expect(ledger.liability()).toBe(500n)
  expect(creditBackingEvidence(payment.backing)).toMatchObject({ available: 600n, bounded: 400n })
})

it('refuses an owner intent before signing if the old earned value was already collected outside the journal', async () => {
  const input = deposit(); earned()
  chain.notes.set('0:0', { ...input, spendtxid: id('unrecorded-collection') })
  await expect(prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })).rejects.toThrow('before signing')
  expect(ledger.pendingOwnerIntent()).toBeUndefined()
})

it('never reclassifies a long canonical scan as fresh backing', async () => {
  const input = deposit(), now = Date.now()
  const block = chain.provider.getBlock.bind(chain.provider)
  vi.spyOn(chain.provider, 'getBlock').mockImplementation(async (tag) => ({ ...await block(tag), timestamp: Math.floor(now / 1000) } as any))
  vi.spyOn(chain.provider, 'call').mockImplementation(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + 46_000)
    return '0x' + '0'.repeat(64)
  })
  await expect(verifyCreditBacking(chain.provider, [input], ledger.accountedNotes(), 2)).rejects.toThrow('Fresh canonical backing head is unavailable')
})

it('holds a nonempty legacy journal on owner-accounting migration instead of inferring uncollected lifetime revenue', () => {
  deposit(); earned()
  store.db.exec('DROP TABLE credit_owner_policy')
  ledger = CreditLedger.load(store)
  expect(() => ledger.assertOwnerJournalReady()).toThrow('saved owner payment')
  expect(store.db.prepare('SELECT value FROM settings WHERE key=?').get('creditOwnerRecoveryRequired')?.value).toBe('1')
})

it('replaces only a provably unrelated candidate without releasing the durable owner intent', async () => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const wrong = receiptFor(id('unrelated-public-transaction'), 20, [])
  chain.receipts.set(wrong.hash, wrong)
  const wrongCanonical = await finalizedCreditReceipt(chain.provider, wrong.hash)
  ledger.recordOwnerPayout(intent.key, wrongCanonical)
  ledger.rejectOwnerPayout(intent.key, wrongCanonical)
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
  expect(ledger.ownerPayouts(intent.key)).toEqual([])
  const actual = await collection(input)
  ledger.recordOwnerPayout(intent.key, actual.receipt)
  expect(() => ledger.rejectOwnerPayout(intent.key, actual.receipt)).toThrow('spent private inputs')
  ledger.settleOwnerCollection(intent.key, actual)
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_owner_candidates').get()?.count).toBe(2)
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_owner_rejections').get()?.count).toBe(1)
})

it.each(['above-net', 'missing-fees', 'unsupported-fee'])('rejects an impossible collection before saving a hold: %s', async (failure) => {
  deposit(2000n); earned(1000n)
  await expect(prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 990n,
    collectionFees: failure === 'missing-fees' ? undefined : { unshieldFeeBps: 25n, gatewayFeeBps: failure === 'unsupported-fee' ? 14n : 13n } }))
    .rejects.toThrow(failure === 'above-net' ? 'exceeds proceeds' : 'collection fees')
  expect(ledger.pendingOwnerIntent()).toBeUndefined()
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_owner_intents').get()?.count).toBe(0)
})

it('rejects dual deposit/change accounting even at the owner-settlement mutation boundary', async () => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const payment = await collection(input)
  ledger.recordOwnerPayout(intent.key, payment.receipt)
  ledger.deposit({ ...provenance(payment.output), owner, amount: payment.output.note.value })
  const boundary = ledger as unknown as { recordOwnerSettlement: (savedIntent: typeof intent, proof: typeof payment.debit,
    privateFee: bigint, unshieldGross: bigint, native: bigint) => void }
  expect(() => boundary.recordOwnerSettlement(intent, payment.debit, 10n, 290n, 289n)).toThrow('credited deposit')
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_owner_settlements').get()?.count).toBe(0)
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM credit_owner_change').get()?.count).toBe(0)
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
})

it('can dismiss another user’s private transaction only with a complete fee-wallet view proof, retaining the intent', async () => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const other = syntheticNote(99n, 999)
  const receipt = receiptFor(id('another-users-private-tx'), 20, [], [other])
  chain.receipts.set(receipt.hash, receipt)
  const canonical = await finalizedCreditReceipt(chain.provider, receipt.hash)
  ledger.recordOwnerPayout(intent.key, canonical)
  expect(() => ledger.rejectOwnerPayout(intent.key, canonical)).toThrow('spent private inputs')
  const proof = await verifyUnrelatedOwnerPayout(chain.provider, canonical, ledger.scope, [input], ledger.accountedNotes())
  expect(() => ledger.rejectOwnerPayout(intent.key, canonical, { ...proof })).toThrow('complete-wallet')
  ledger.rejectOwnerPayout(intent.key, canonical, proof)
  expect(ledger.ownerPayouts(intent.key)).toEqual([])
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
  const actual = await collection(input)
  ledger.recordOwnerPayout(intent.key, actual.receipt)
  ledger.settleOwnerCollection(intent.key, actual)
  expect(ledger.pendingOwnerIntent()).toBeUndefined()
})

it.each(['accounted', 'unclaimed', 'incomplete-scan', 'stale-proof', 'new-claim'])('retains owner holds for unsafe rejection evidence: %s', async (failure) => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const extra = syntheticNote(99n, 999), owned = failure === 'accounted' ? input : extra
  const receipt = receiptFor(id(`unsafe-private-${failure}`), 20, [], [owned])
  chain.receipts.set(receipt.hash, receipt)
  const canonical = await finalizedCreditReceipt(chain.provider, receipt.hash)
  ledger.recordOwnerPayout(intent.key, canonical)
  if (['accounted', 'unclaimed', 'incomplete-scan'].includes(failure)) {
    const notes = failure === 'incomplete-scan' ? [] : failure === 'unclaimed' ? [input, extra] : [input]
    await expect(verifyUnrelatedOwnerPayout(chain.provider, canonical, ledger.scope, notes, ledger.accountedNotes())).rejects.toThrow()
  } else {
    const proof = await verifyUnrelatedOwnerPayout(chain.provider, canonical, ledger.scope, [input], ledger.accountedNotes())
    if (failure === 'new-claim') deposit(1n, 1)
    else { const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 45_001) }
    expect(() => ledger.rejectOwnerPayout(intent.key, canonical, proof)).toThrow('complete-wallet')
  }
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
  expect(ledger.ownerPayouts(intent.key)).toHaveLength(1)
})

it.each(['changed-logs', 'changed-status', 'oversized-logs'])('rejects inconsistent canonical unrelated receipt evidence: %s', async (failure) => {
  const input = deposit(); earned()
  const intent = await prepare({ ...policy, kind: 'collection', maximumPrivateFee: 10n, minimumNative: 280n })
  const other = syntheticNote(99n, 999), receipt = receiptFor(id(`changed-unrelated-${failure}`), 20, [], [other])
  chain.receipts.set(receipt.hash, receipt)
  const canonical = await finalizedCreditReceipt(chain.provider, receipt.hash)
  ledger.recordOwnerPayout(intent.key, canonical)
  const changed = { ...receipt, logs: failure === 'oversized-logs' ? Array(1025).fill(receipt.logs[0])
    : failure === 'changed-logs' ? receiptFor(receipt.hash, 20, [], [input]).logs : receipt.logs,
    status: failure === 'changed-status' ? 0 : 1 } as typeof receipt
  chain.receipts.set(receipt.hash, changed)
  await expect(verifyUnrelatedOwnerPayout(chain.provider, canonical, ledger.scope, [input], ledger.accountedNotes())).rejects.toThrow()
  expect(ledger.ownerPayouts(intent.key)).toHaveLength(1)
  expect(ledger.pendingOwnerIntent()?.key).toBe(intent.key)
})
