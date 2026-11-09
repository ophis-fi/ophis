import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { id, Wallet, ZeroAddress } from 'ethers'
import { Store } from '../src/storage'
import { CreditLedger } from '../src/credit'
import { cliBacking } from './main-sdk.fixture'
import { accountingReport } from '../src/operations'
import { CHAIN_ID, TOKENS } from '../src/config'

const recipient = '0zk1qy08nqrftxezyxdegx6ca055tr65f2hf3u24j9urx04e5fnzepv6nrv7j6fe3z53luvr6qkgtjukzmkcp856gs5a6wzdd3pnesr9r6ljvym9l3a4fcepgkvek3f'
const owner = Wallet.createRandom().address, operator = Wallet.createRandom().address
let root: string, store: Store
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'credit-accounting-')); store = new Store(root) })
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }) })

it('separates unused customer credit from earned charges and keeps prefinality gas exposure visible', async () => {
  const ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', token: TOKENS[0].address })
  const deposited = 9007199254740993n
  ledger.deposit({ owner, amount: deposited, transactionHash: id('deposit'), commitment: id('note'),
    blockNumber: 10, blockHash: id('canonical'), tree: 0, position: 0 })
  store.db.prepare('INSERT INTO credit_owner_sequences(owner,sequence) VALUES(?,1)').run(owner)
  store.db.prepare('INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,charged,settlement_hash,sequence) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id('paid'), owner, 'fixture', '100', '1000000000000000000', '0', '70', id('receipt'), 1)
  store.db.prepare('UPDATE credit_owner_sequences SET sequence=2 WHERE owner=?').run(owner)
  store.db.prepare('INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,sequence) VALUES(?,?,?,?,?,?,?)')
    .run(id('included'), owner, 'fixture', '200', '1000000000000000000', '0', 2)
  for (const key of [id('paid'), id('included')])
    store.db.prepare('INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce) VALUES(?,?,?,?,?,?,?)')
      .run(key, 'PRIVATE-MUST-NOT-EXPORT', 0, key === id('paid') ? '100' : '200', 0, JSON.stringify({ kind: 'prepaid', charged: '70', receiptHash: id('receipt') }), key === id('paid') ? 0 : 1)
  store.db.prepare('UPDATE requests SET confirmed=1,assured=1,actual_cost=? WHERE key=?').run('60', id('paid'))
  store.db.prepare('UPDATE requests SET confirmed=1 WHERE key=?').run(id('included'))
  ledger.reserveRefund(id('paid-refund'), owner, recipient, 500n, 450n, ledger.nextSequence(owner), await cliBacking(ledger.accountedNotes()), 1n)
  store.db.prepare('UPDATE credit_refunds SET transaction_hash=? WHERE key=?').run(id('refund-tx'), id('paid-refund'))
  // Report-only historical fixture: the completed payout is not a canonical settlement proof for new admission.
  store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created,sequence) VALUES(?,?,?,?,?,?,?)')
    .run(id('unpaid-refund'), owner, recipient, '300', '280', Date.now(), ledger.nextSequence(owner))
  const report = accountingReport(store.db)
  expect(report.receivedFees).toEqual({ [TOKENS[0].address]: '120' })
  expect(report.recordedGasExpenseWei).toBe('60')
  expect(report.unresolvedMaximumWei).toBe('200')
  expect(report.historicalSettlementsWithoutFeeAmounts).toBe(0)
  expect(report.prepaidCredit).toEqual({ token: TOKENS[0].address, deposited: String(deposited), charged: '70',
    reserved: '200', pendingRefunds: '300', completedRefunds: '500', refundFees: '50', liability: String(deposited - 570n),
    remainingEarned: '120', collectedGross: '0', ownerPrivateFees: '0', nativeCollected: '0', ownerPaymentsPending: 0 })
  expect(JSON.stringify(report)).not.toContain('PRIVATE-MUST-NOT-EXPORT')
  store.db.prepare('UPDATE requests SET fee_data=? WHERE key=?').run(JSON.stringify({ kind: 'prepaid', charged: '71', receiptHash: id('receipt') }), id('paid'))
  expect(() => accountingReport(store.db)).toThrow('settlement accounting')
})

it('keeps a refund-only deposit as customer liability until payout and exposes only the retained fee afterward', async () => {
  const ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator, recipient: '0zk1qycrffu7psx6udqv62vjfrx85kf9fxvzcwzjxfpj5nw59urf46c0trv7j6fe3z53lu9xnx4de52xjyewrs8me5u49mte0sc06unkwkppmyx05qyrsvjt7yqt7sm', token: TOKENS[0].address })
  ledger.deposit({ owner, amount: 1000n, transactionHash: id('refund-only-deposit'), commitment: id('refund-only-note'),
    blockNumber: 10, blockHash: id('canonical'), tree: 0, position: 0 })
  const key = id('refund-only')
  ledger.reserveRefund(key, owner, recipient, 800n, 650n, ledger.nextSequence(owner), await cliBacking(ledger.accountedNotes()), 1n)
  const pending = accountingReport(store.db)
  expect(pending.receivedFees[TOKENS[0].address]).toBe('0')
  expect(pending.prepaidCredit!.liability).toBe('1000')
  expect(pending.prepaidCredit!.pendingRefunds).toBe('800')
  expect(ledger.balance(owner).available).toBe(200n)
  // Accounting fixture for a verified completed payout; proof verification has separate SDK tests.
  store.db.prepare('UPDATE credit_refunds SET transaction_hash=? WHERE key=?').run(id('verified-refund-only'), key)
  const completed = accountingReport(store.db)
  const remainingPrivateTokens = 1000n - 650n
  expect(completed.receivedFees[TOKENS[0].address]).toBe('150')
  expect(completed.prepaidCredit!.liability).toBe('200')
  expect(remainingPrivateTokens - BigInt(completed.receivedFees[TOKENS[0].address])).toBe(ledger.liability())
  expect(completed.recordedGasExpenseWei).toBe('0')
})


it('keeps repeated native payments in customer liability without reporting them as spendable credit or earned fees', () => {
  const ledger = new CreditLedger(store, { chainId: CHAIN_ID, operator, recipient: operator, token: ZeroAddress, funding: 'native' })
  const insert = (table: string, paymentId: string, transactionHash: string, amount: string) =>
    store.db.prepare(`INSERT INTO ${table}(payment_id,owner,transaction_hash,block_number,block_hash,amount) VALUES(?,?,?,?,?,?)`)
      .run(paymentId, owner, transactionHash, 10, id('native block'), amount)
  // Report-only persisted-history fixture; native payment verification is independently exercised before ledger insertion.
  insert('credit_native_deposits', id('native id'), id('native payment'), '1000')
  insert('credit_native_duplicate_deposits', id('native id'), id('native repeated payment'), '250')
  const report = accountingReport(store.db)
  expect(report.prepaidCredit).toMatchObject({ funding: 'native', token: ZeroAddress, deposited: '1250',
    quarantined: '250', liability: '1250', charged: '0', remainingEarned: '0', nativeCollected: '0' })
  expect(report.receivedFees).toEqual({ [ZeroAddress]: '0' })
  expect(ledger.balance(owner).available).toBe(1000n)
  expect(ledger.liability()).toBe(1250n)
})
