import { withdrawalPilotKey } from './prepaid-pilot'
import { getAddress, hexlify, isHexString, randomBytes, Transaction, ZeroAddress, type TransactionReceipt } from 'ethers'
import type { Store } from './storage'
import type { CreditScope } from '../../railgun/credit-protocol'
import { creditRefundMemo } from '../../railgun/credit-protocol'
import { finalizedCreditEvidence } from './credit-payment'
import { getRailgunWalletAddressData, validateRailgunAddress } from '@railgun-community/wallet'
import { creditBackingEvidence, type CreditBacking } from './credit-backing'
import { assertUnrelatedOwnerPayout, ownerDebitEvidence, type AccountedNote, type VerifiedOwnerDebit,
  type VerifiedUnrelatedOwnerPayout } from './credit-owner-payment'
import { ANON_COLLECTION_BASE_FEE_BPS, nativeCollectionEvidence, type VerifiedNativeCollection } from './anon-native-collection'
import { PROXY } from './transaction'
import { NETWORK } from './config'
import { nativeBackingEvidence, nativeDepositEvidence, nativeHistoryCatalog, nativeScope, type NativeCreditBacking,
  type NativeDepositAnchor, type NativeSettlementAnchor, type VerifiedNativeDeposit } from './credit-native-payment'

export type { CreditScope } from '../../railgun/credit-protocol'
export interface ConfirmedCredit {
  owner: string; tree: number; position: number; commitment: string
  transactionHash: string; blockNumber: number; blockHash: string; amount: bigint
}
export interface ConfirmedRefund {
  receipt: TransactionReceipt; commitment: string; recipient: string; token: string; amount: bigint; memo: string | undefined
  debit?: VerifiedOwnerDebit; backing?: CreditBacking
}
export interface OwnerIntent {
  key: string; kind: 'refund' | 'collection'; refund_key: string | null; debit: string; maximum_private_fee: string
  minimum_native: string; gas_to_recover: string; prior_private_fees: string; input_limit: number; margin_bps: number
  output_limit: number; proof_limit: number; ledger_id: string; created: number
}
export interface ConfirmedCollection { debit: VerifiedOwnerDebit; native: VerifiedNativeCollection; backing: CreditBacking }
export interface RefundPayout { transaction_hash: string; block_number: number; block_hash: string }
export interface CreditAttempt {
  key: string; owner: string; envelope: string; unsigned: string; nonce: number; sequence: number
  gasBudget: bigint; maximumCharge: bigint; rate: bigint; collectionAllowance: bigint
  expiration: number; dailyBudget: bigint
  withdrawalPilot?: boolean
  prepaidPilotLedgerId?: string
  backing: CreditBacking | NativeCreditBacking
  nativeReserve?: bigint
  nativeRefund?: { recipient: string; net: bigint }
}
interface AttemptRow {
  key: string; owner: string; unsigned: string; maximum_charge: string; rate: string
  collection_allowance: string; charged: string | null; settlement_hash: string | null; sequence: number | null
}
export interface CreditRefundRow {
  key: string; owner: string; recipient: string; gross: string; net: string; transaction_hash: string | null
  commitment: string | null; block_hash: string | null; block_number: number | null; sequence: number | null
}

const SCALE = 10n ** 18n
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER - 1
export const creditSequence = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_SEQUENCE)
    throw new Error('A valid prepaid request sequence is required.')
  return value
}
const quantity = (value: unknown, positive = false): bigint => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(value)) throw new Error('Invalid credit quantity.')
  const result = BigInt(value)
  if (result >= 2n ** 256n || (positive && result === 0n)) throw new Error('Invalid credit quantity.')
  return result
}
const hash = (value: string): string => {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error('Invalid credit identifier.')
  return value.toLowerCase()
}
const ownerAddress = (value: string): string => {
  const address = getAddress(value)
  if (address === ZeroAddress) throw new Error('Invalid credit owner.')
  return address
}
const samePrivateIdentity = (left: string, right: string): boolean => {
  const a = getRailgunWalletAddressData(left), b = getRailgunWalletAddressData(right)
  return a.masterPublicKey === b.masterPublicKey && Buffer.from(a.viewingPublicKey).equals(Buffer.from(b.viewingPublicKey))
}
export const creditCharge = (gasCost: bigint, rate: bigint, collectionAllowance: bigint): bigint => {
  if (gasCost < 0n || rate < SCALE || collectionAllowance < 0n) throw new Error('Invalid credit pricing.')
  return quantity((((gasCost + collectionAllowance) * rate + SCALE - 1n) / SCALE).toString())
}

/** Uses the operator journal so payment reservation and nonce ownership commit together. */
export class CreditLedger {
  readonly id: string
  readonly scope: CreditScope
  private readonly initialNonce: number
  static load(store: Store): CreditLedger {
    const saved = store.db.prepare('SELECT scope FROM credit_identity WHERE singleton=1').get()
    if (typeof saved?.scope !== 'string') throw new Error('Missing credit ledger identity.')
    return new CreditLedger(store, JSON.parse(saved.scope) as CreditScope)
  }
  constructor(private readonly store: Store, scope: CreditScope, initialNonce = 0) {
    const native = scope.funding === 'native'
    if (![1, 56].includes(scope.chainId) || (scope.funding !== undefined && !native) ||
      (native ? getAddress(scope.recipient) !== getAddress(scope.operator) || getAddress(scope.token) !== ZeroAddress : !validateRailgunAddress(scope.recipient)))
      throw new Error('Unsupported credit scope.')
    if (!Number.isSafeInteger(initialNonce) || initialNonce < 0) throw new Error('Invalid initial operator nonce.')
    this.scope = { chainId: scope.chainId, operator: ownerAddress(scope.operator), recipient: native ? getAddress(scope.operator) : scope.recipient,
      token: native ? ZeroAddress : ownerAddress(scope.token), ...(native ? { funding: 'native' as const } : {}) }
    // A funding switch cannot reinterpret even an empty existing private ledger, or mutate it before rejection.
    if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='credit_identity'").get()) {
      const prior = store.db.prepare('SELECT scope FROM credit_identity WHERE singleton=1').get()
      if (prior && prior.scope !== JSON.stringify(this.scope)) throw new Error('Credit ledger identity changed; use a separately reviewed fresh ledger.')
    }
    store.bindIdentity(this.scope.chainId, this.scope.operator)
    const db = store.db
    db.exec(`CREATE TABLE IF NOT EXISTS credit_identity (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, scope TEXT NOT NULL, initial_nonce INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_deposits (
        tree INTEGER NOT NULL, position INTEGER NOT NULL, commitment TEXT NOT NULL,
        owner TEXT NOT NULL, transaction_hash TEXT NOT NULL, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, amount TEXT NOT NULL, PRIMARY KEY(tree,position));
      CREATE TABLE IF NOT EXISTS credit_attempts (
        key TEXT PRIMARY KEY, owner TEXT NOT NULL, unsigned TEXT NOT NULL, maximum_charge TEXT NOT NULL,
        rate TEXT NOT NULL, collection_allowance TEXT NOT NULL, charged TEXT, settlement_hash TEXT);
      CREATE TABLE IF NOT EXISTS credit_retired_requests (
        key TEXT PRIMARY KEY, owner TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('execute','refund')),
        created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_owner_sequences (
        owner TEXT NOT NULL PRIMARY KEY, sequence INTEGER NOT NULL
        CHECK(typeof(sequence)='integer' AND sequence BETWEEN 1 AND ${MAX_SEQUENCE}));
      CREATE TRIGGER IF NOT EXISTS monotonic_credit_sequence_insert BEFORE INSERT ON credit_owner_sequences
        WHEN NEW.sequence<>1 OR EXISTS(SELECT 1 FROM credit_owner_sequences WHERE owner=NEW.owner)
        BEGIN SELECT RAISE(ABORT,'Credit owner sequences must begin once at one'); END;
      CREATE TRIGGER IF NOT EXISTS monotonic_credit_sequence_update BEFORE UPDATE ON credit_owner_sequences
        WHEN NEW.owner IS NOT OLD.owner OR NEW.sequence<>OLD.sequence+1
        BEGIN SELECT RAISE(ABORT,'Credit owner sequences must advance by one'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_sequence_delete BEFORE DELETE ON credit_owner_sequences
        BEGIN SELECT RAISE(ABORT,'Credit owner sequences cannot be deleted'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_retirement_update BEFORE UPDATE ON credit_retired_requests
        BEGIN SELECT RAISE(ABORT,'Retired credit requests are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_retirement_delete BEFORE DELETE ON credit_retired_requests
        BEGIN SELECT RAISE(ABORT,'Retired credit requests are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_retirement_replace BEFORE INSERT ON credit_retired_requests
        WHEN EXISTS(SELECT 1 FROM credit_retired_requests WHERE key=NEW.key)
        BEGIN SELECT RAISE(ABORT,'Retired credit requests are immutable'); END;
      CREATE TABLE IF NOT EXISTS credit_refunds (
        key TEXT PRIMARY KEY, owner TEXT NOT NULL, recipient TEXT NOT NULL, gross TEXT NOT NULL,
        net TEXT NOT NULL, transaction_hash TEXT, commitment TEXT UNIQUE, block_hash TEXT, block_number INTEGER,
        created INTEGER NOT NULL, checked_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS credit_refund_payouts (
        refund_key TEXT NOT NULL, transaction_hash TEXT NOT NULL, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(refund_key,transaction_hash));
      CREATE TRIGGER IF NOT EXISTS immutable_refund_payout_update BEFORE UPDATE ON credit_refund_payouts
        BEGIN SELECT RAISE(ABORT,'Owner refund payout assignments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_refund_payout_delete BEFORE DELETE ON credit_refund_payouts
        BEGIN SELECT RAISE(ABORT,'Owner refund payout assignments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_refund_payout_replace BEFORE INSERT ON credit_refund_payouts
        WHEN EXISTS(SELECT 1 FROM credit_refund_payouts WHERE refund_key=NEW.refund_key AND transaction_hash=NEW.transaction_hash)
        BEGIN SELECT RAISE(ABORT,'Owner refund payout assignments are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_identity_update BEFORE UPDATE ON credit_identity
        BEGIN SELECT RAISE(ABORT,'Credit identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_identity_delete BEFORE DELETE ON credit_identity
        BEGIN SELECT RAISE(ABORT,'Credit identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_identity_replace BEFORE INSERT ON credit_identity
        WHEN EXISTS(SELECT 1 FROM credit_identity)
        BEGIN SELECT RAISE(ABORT,'Credit identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_deposit_update BEFORE UPDATE ON credit_deposits
        BEGIN SELECT RAISE(ABORT,'Confirmed credit deposits are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_deposit_delete BEFORE DELETE ON credit_deposits
        BEGIN SELECT RAISE(ABORT,'Confirmed credit deposits are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_credit_deposit_replace BEFORE INSERT ON credit_deposits
        WHEN EXISTS(SELECT 1 FROM credit_deposits WHERE tree=NEW.tree AND position=NEW.position)
        BEGIN SELECT RAISE(ABORT,'Confirmed credit deposits are immutable'); END;`)
    this.atomic(() => {
      for (const table of ['credit_attempts', 'credit_refunds']) {
        if (!db.prepare(`PRAGMA table_info(${table})`).all().some((column) => column.name === 'sequence'))
          db.exec(`ALTER TABLE ${table} ADD COLUMN sequence INTEGER`)
        db.exec(`CREATE TRIGGER IF NOT EXISTS require_${table}_sequence BEFORE INSERT ON ${table}
          WHEN NEW.sequence IS NULL OR typeof(NEW.sequence)<>'integer' OR NEW.sequence NOT BETWEEN 1 AND ${MAX_SEQUENCE}
          BEGIN SELECT RAISE(ABORT,'New prepaid holds require a request sequence'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_${table}_sequence BEFORE UPDATE OF sequence ON ${table}
          WHEN NEW.sequence IS NOT OLD.sequence
          BEGIN SELECT RAISE(ABORT,'Saved prepaid hold sequences are immutable'); END;`)
      }
      db.exec(`CREATE TRIGGER IF NOT EXISTS disable_new_credit_retirements BEFORE INSERT ON credit_retired_requests
        BEGIN SELECT RAISE(ABORT,'Per-request credit retirement storage is disabled'); END;`)
    })
    this.id = this.atomic(() => {
      const identity = db.prepare('SELECT id,scope FROM credit_identity WHERE singleton=1').get()
      const encoded = JSON.stringify(this.scope)
      if (identity) {
        if (identity.scope !== encoded || typeof identity.id !== 'string') throw new Error('Credit ledger identity changed.')
        return hash(identity.id)
      }
      const id = hexlify(randomBytes(32))
      db.prepare('INSERT INTO credit_identity(singleton,id,scope,initial_nonce) VALUES(1,?,?,?)').run(id, encoded, initialNonce)
      return id
    })
    const savedNonce = db.prepare('SELECT initial_nonce FROM credit_identity WHERE singleton=1').get()?.initial_nonce
    if (typeof savedNonce !== 'number' || !Number.isSafeInteger(savedNonce) || savedNonce < 0) throw new Error('Corrupt credit nonce anchor.')
    this.initialNonce = savedNonce
    db.exec(`CREATE TABLE IF NOT EXISTS credit_owner_policy (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), ledger_id TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_owner_intents (
      key TEXT PRIMARY KEY, ledger_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('refund','collection')),
      refund_key TEXT UNIQUE, debit TEXT NOT NULL, maximum_private_fee TEXT NOT NULL, minimum_native TEXT NOT NULL,
      gas_to_recover TEXT NOT NULL, prior_private_fees TEXT NOT NULL, input_limit INTEGER NOT NULL,
      margin_bps INTEGER NOT NULL, output_limit INTEGER NOT NULL, proof_limit INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_owner_candidates (
        intent_key TEXT NOT NULL, transaction_hash TEXT NOT NULL UNIQUE, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, PRIMARY KEY(intent_key,transaction_hash));
      CREATE TABLE IF NOT EXISTS credit_owner_rejections (
        transaction_hash TEXT PRIMARY KEY, intent_key TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason='no-pool-nullifiers'));
      CREATE TABLE IF NOT EXISTS credit_owner_unrelated_rejections (
        transaction_hash TEXT PRIMARY KEY, intent_key TEXT NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
        reason TEXT NOT NULL CHECK(reason='no-fee-wallet-nullifiers'));
      CREATE TABLE IF NOT EXISTS credit_owner_settlements (
        intent_key TEXT PRIMARY KEY, transaction_hash TEXT NOT NULL UNIQUE, block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL, debit TEXT NOT NULL, private_fee TEXT NOT NULL, unshield_gross TEXT NOT NULL,
        native_received TEXT NOT NULL, gas_recovered TEXT NOT NULL, prior_fees_covered TEXT NOT NULL, inputs TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credit_owner_change (
        tree INTEGER NOT NULL, position INTEGER NOT NULL, commitment TEXT NOT NULL, transaction_hash TEXT NOT NULL,
        block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, amount TEXT NOT NULL, intent_key TEXT NOT NULL,
        PRIMARY KEY(tree,position));`)
    if (native) {
      db.exec(`CREATE TABLE IF NOT EXISTS credit_native_deposits (
        payment_id TEXT PRIMARY KEY,owner TEXT NOT NULL,transaction_hash TEXT UNIQUE NOT NULL,
        block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,amount TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS credit_native_duplicate_deposits (
        payment_id TEXT NOT NULL,owner TEXT NOT NULL,transaction_hash TEXT PRIMARY KEY,
        block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,amount TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS credit_native_refund_attempts (key TEXT PRIMARY KEY,recipient TEXT NOT NULL,net TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS credit_native_refund_settlements (key TEXT PRIMARY KEY,paid TEXT NOT NULL,
        transaction_hash TEXT UNIQUE NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,status INTEGER NOT NULL);`)
      for (const table of ['credit_native_deposits','credit_native_duplicate_deposits','credit_native_refund_attempts','credit_native_refund_settlements']) {
        const unique = table === 'credit_native_deposits' ? 'payment_id=NEW.payment_id OR transaction_hash=NEW.transaction_hash'
          : table === 'credit_native_duplicate_deposits' ? 'transaction_hash=NEW.transaction_hash' : 'key=NEW.key'
        db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table}
          BEGIN SELECT RAISE(ABORT,'Native credit history is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table}
          BEGIN SELECT RAISE(ABORT,'Native credit history is immutable'); END;
          CREATE TRIGGER IF NOT EXISTS immutable_${table}_replace BEFORE INSERT ON ${table}
          WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${unique}) BEGIN SELECT RAISE(ABORT,'Native credit history is immutable'); END;`)
      }
    }
    const policy = db.prepare('SELECT ledger_id,version FROM credit_owner_policy WHERE singleton=1').get()
    if (policy && (policy.ledger_id !== this.id || policy.version !== 1)) throw new Error('Owner journal version or ledger identity changed.')
    if (!policy) {
      if (db.prepare('SELECT 1 FROM credit_deposits UNION ALL SELECT 1 FROM credit_attempts UNION ALL SELECT 1 FROM credit_refunds LIMIT 1').get())
        db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('creditOwnerRecoveryRequired', '1')
      db.prepare('INSERT INTO credit_owner_policy(singleton,ledger_id,version) VALUES(1,?,1)').run(this.id)
    }
    for (const table of ['credit_owner_policy', 'credit_owner_intents', 'credit_owner_candidates', 'credit_owner_rejections', 'credit_owner_unrelated_rejections', 'credit_owner_settlements', 'credit_owner_change']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_update BEFORE UPDATE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Owner payment journal is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_${table}_delete BEFORE DELETE ON ${table}
        BEGIN SELECT RAISE(ABORT,'Owner payment journal is immutable'); END;`)
      const condition = table === 'credit_owner_policy' ? 'singleton=NEW.singleton' : table === 'credit_owner_intents' ? 'key=NEW.key' : table === 'credit_owner_change'
        ? 'tree=NEW.tree AND position=NEW.position' : table === 'credit_owner_rejections' || table === 'credit_owner_unrelated_rejections' ? 'transaction_hash=NEW.transaction_hash'
          : table === 'credit_owner_candidates' ? 'transaction_hash=NEW.transaction_hash' : 'intent_key=NEW.intent_key'
      db.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_replace BEFORE INSERT ON ${table}
        WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${condition})
        BEGIN SELECT RAISE(ABORT,'Owner payment journal is immutable'); END;`)
    }
  }
  get isNative(): boolean { return this.scope.funding === 'native' }
  hasUnsettledNativeAttempt(): boolean {
    return this.isNative && !!this.store.db.prepare('SELECT 1 FROM credit_attempts WHERE charged IS NULL LIMIT 1').get()
  }
  private depositTable(): string { return this.isNative ? 'credit_native_deposits' : 'credit_deposits' }
  private assertPrivateCredit(): void { if (this.isNative) throw new Error('Private owner operations cannot spend native customer credit.') }
  nativeDeposits(): NativeDepositAnchor[] {
    if (!this.isNative) throw new Error('This ledger is not native-funded.')
    return this.store.db.prepare(`SELECT payment_id AS paymentId,owner,transaction_hash AS transactionHash,
      block_number AS blockNumber,block_hash AS blockHash,amount FROM credit_native_deposits UNION ALL
      SELECT payment_id AS paymentId,owner,transaction_hash AS transactionHash,block_number AS blockNumber,
      block_hash AS blockHash,amount FROM credit_native_duplicate_deposits`).all() as unknown as NativeDepositAnchor[]
  }
  nativeSettlements(): NativeSettlementAnchor[] {
    if (!this.isNative) throw new Error('This ledger is not native-funded.')
    return this.store.db.prepare(`SELECT a.settlement_hash AS transactionHash,
      json_extract(r.fee_data,'$.blockNumber') AS blockNumber,json_extract(r.fee_data,'$.blockHash') AS blockHash
      FROM credit_attempts a JOIN requests r ON r.key=a.key WHERE a.charged IS NOT NULL`).all() as unknown as NativeSettlementAnchor[]
  }
  nativeRefund(key: string): { key: string; recipient: string; net: string; paid: string | null;
    transaction_hash: string | null; status: number | null } | undefined {
    if (!this.isNative) return undefined
    return this.store.db.prepare(`SELECT i.key,i.recipient,i.net,s.paid,s.transaction_hash,s.status
      FROM credit_native_refund_attempts i LEFT JOIN credit_native_refund_settlements s ON s.key=i.key WHERE i.key=?`)
      .get(hash(key)) as ReturnType<CreditLedger['nativeRefund']>
  }
  depositNative(proof: VerifiedNativeDeposit): boolean {
    if (!this.isNative) throw new Error('Native payment cannot fund a private ledger.')
    const payment = nativeDepositEvidence(proof)
    if (payment.ledgerId !== this.id || payment.scope !== nativeScope(this.scope, this.id)) throw new Error('Native payment belongs to another ledger.')
    const result = this.atomic(() => {
      const byHash = this.store.db.prepare(`SELECT * FROM credit_native_deposits WHERE transaction_hash=? UNION ALL
        SELECT * FROM credit_native_duplicate_deposits WHERE transaction_hash=?`).get(payment.transactionHash, payment.transactionHash)
      if (byHash) {
        if (byHash.payment_id !== payment.paymentId || byHash.owner !== payment.owner || byHash.amount !== payment.amount ||
          byHash.block_number !== payment.blockNumber || byHash.block_hash !== payment.blockHash) throw new Error('Native payment was already assigned differently.')
        return this.store.db.prepare('SELECT 1 FROM credit_native_duplicate_deposits WHERE transaction_hash=?').get(payment.transactionHash) ? 'duplicate' : 'replay'
      }
      const duplicate = !!this.store.db.prepare('SELECT 1 FROM credit_native_deposits WHERE payment_id=?').get(payment.paymentId)
      const table = duplicate ? 'credit_native_duplicate_deposits' : 'credit_native_deposits'
      this.store.db.prepare(`INSERT INTO ${table}(payment_id,owner,transaction_hash,block_number,block_hash,amount) VALUES(?,?,?,?,?,?)`)
        .run(payment.paymentId,payment.owner,payment.transactionHash,payment.blockNumber,payment.blockHash,payment.amount)
      return duplicate ? 'duplicate' : 'inserted'
    })
    if (result === 'duplicate') throw new Error('Repeated native payment ID: additional funds are recorded as quarantined customer liability pending recovery.')
    return result === 'inserted'
  }
  assertNativeBacked(proof: NativeCreditBacking, reserve: bigint, nonce?: number): void {
    if (!this.isNative || reserve <= 0n) throw new Error('An explicit native reserve is required.')
    quantity(reserve.toString(), true)
    const value = nativeBackingEvidence(proof)
    if (value.ledgerId !== this.id || value.scope !== nativeScope(this.scope, this.id) ||
      value.catalog !== nativeHistoryCatalog(this.nativeDeposits(), this.nativeSettlements()) ||
      value.available < this.liability() + reserve || (nonce !== undefined && value.nonce !== nonce))
      throw new Error('Native balance or canonical history does not cover all customer liabilities and reserve.')
  }
  private atomic<T>(run: () => T): T {
    this.store.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.store.db.exec('COMMIT')
      return result
    } catch (error) {
      try { this.store.db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back. */ }
      throw error
    }
  }
  deposit(payment: ConfirmedCredit): boolean {
    this.assertPrivateCredit()
    const owner = ownerAddress(payment.owner), commitment = hash(payment.commitment)
    const transactionHash = hash(payment.transactionHash), blockHash = hash(payment.blockHash)
    const amount = quantity(payment.amount.toString(), true).toString()
    if (!Number.isSafeInteger(payment.blockNumber) || payment.blockNumber < 0) throw new Error('Invalid payment block.')
    if (!Number.isSafeInteger(payment.tree) || payment.tree < 0 || !Number.isSafeInteger(payment.position) ||
      payment.position < 0 || payment.position >= 2 ** 16) throw new Error('Invalid payment leaf position.')
    return this.atomic(() => {
      if (this.store.db.prepare('SELECT 1 FROM credit_owner_change WHERE tree=? AND position=?').get(payment.tree, payment.position))
        throw new Error('Accounted owner change cannot be claimed as a new deposit.')
      const existing = this.store.db.prepare('SELECT * FROM credit_deposits WHERE tree=? AND position=?').get(payment.tree, payment.position)
      if (existing) {
        if (existing.commitment !== commitment || existing.owner !== owner || existing.transaction_hash !== transactionHash || existing.block_hash !== blockHash ||
          existing.block_number !== payment.blockNumber || existing.amount !== amount)
          throw new Error('Confirmed payment was already credited with different details.')
        return false
      }
      this.store.db.prepare(`INSERT INTO credit_deposits(tree,position,commitment,owner,transaction_hash,block_number,block_hash,amount)
        VALUES(?,?,?,?,?,?,?,?)`).run(payment.tree, payment.position, commitment, owner, transactionHash, payment.blockNumber, blockHash, amount)
      return true
    })
  }
  balance(rawOwner: string): { deposited: bigint; charged: bigint; reserved: bigint; refunds: bigint; available: bigint; quarantined?: bigint } {
    const owner = ownerAddress(rawOwner), db = this.store.db
    const deposited = db.prepare(`SELECT amount FROM ${this.depositTable()} WHERE owner=?`).all(owner)
      .reduce((total, row) => total + quantity(row.amount, true), 0n)
    let charged = 0n, reserved = 0n
    for (const row of db.prepare('SELECT maximum_charge,charged FROM credit_attempts WHERE owner=?').all(owner)) {
      const maximum = quantity(row.maximum_charge, true)
      if (row.charged === null) reserved += maximum
      else {
        const actual = quantity(row.charged)
        if (actual > maximum) throw new Error('Credit settlement exceeds its reservation.')
        charged += actual
      }
    }
    const refunds = this.isNative ? db.prepare(`SELECT s.paid FROM credit_native_refund_settlements s
      JOIN credit_attempts a ON a.key=s.key WHERE a.owner=?`).all(owner).reduce((total,row) => total + quantity(row.paid), 0n)
      : db.prepare('SELECT gross FROM credit_refunds WHERE owner=?').all(owner).reduce((total, row) => total + quantity(row.gross, true), 0n)
    if (this.isNative) charged -= refunds
    const available = deposited - charged - reserved - refunds
    if (available < 0n) throw new Error('Credit ledger is inconsistent.')
    const quarantined = this.isNative ? db.prepare('SELECT amount FROM credit_native_duplicate_deposits WHERE owner=?').all(owner)
      .reduce((total,row) => total + quantity(row.amount,true),0n) : undefined
    return { deposited, charged, reserved, refunds, available, ...(quarantined !== undefined ? { quarantined } : {}) }
  }
  hasDeposit(rawOwner: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM ${this.depositTable()} WHERE owner=? LIMIT 1`).get(ownerAddress(rawOwner))
  }
  liability(): bigint {
    const sum = (sql: string) => this.store.db.prepare(sql).all().reduce((value, row) => value + quantity(row.amount), 0n)
    const total = sum(`SELECT amount FROM ${this.depositTable()}`) + (this.isNative ? sum('SELECT amount FROM credit_native_duplicate_deposits') : 0n) - sum('SELECT charged AS amount FROM credit_attempts WHERE charged IS NOT NULL') -
      sum('SELECT gross AS amount FROM credit_refunds WHERE transaction_hash IS NOT NULL')
    if (total < 0n) throw new Error('Credit liabilities are inconsistent.')
    return total
  }
  earned(): bigint {
    if (this.isNative) {
      const charges = this.store.db.prepare(`SELECT a.charged,r.actual_cost FROM credit_attempts a JOIN requests r ON r.key=a.key
        WHERE a.charged IS NOT NULL`).all().reduce((total,row) => total + quantity(row.charged) - quantity(row.actual_cost),0n)
      const paid = this.store.db.prepare('SELECT paid FROM credit_native_refund_settlements').all().reduce((total,row) => total + quantity(row.paid),0n)
      if (charges < paid) throw new Error('Native earned fees are inconsistent.')
      return charges - paid
    }
    const sum = (sql: string) => this.store.db.prepare(sql).all().reduce((total, row) => total + quantity(row.amount), 0n)
    const earned = sum('SELECT charged AS amount FROM credit_attempts WHERE charged IS NOT NULL') +
      sum('SELECT gross AS amount FROM credit_refunds WHERE transaction_hash IS NOT NULL') -
      sum('SELECT net AS amount FROM credit_refunds WHERE transaction_hash IS NOT NULL') -
      sum('SELECT private_fee AS amount FROM credit_owner_settlements') -
      sum('SELECT unshield_gross AS amount FROM credit_owner_settlements')
    if (earned < 0n) throw new Error('Owner collections exceed accounted earned fees.')
    return earned
  }
  requiredBacking(): bigint { return this.liability() + (this.isNative ? 0n : this.earned()) }
  maximumPendingCharges(): bigint {
    return this.store.db.prepare('SELECT maximum_charge FROM credit_attempts WHERE charged IS NULL').all()
      .reduce((total, row) => total + quantity(row.maximum_charge, true), 0n)
  }
  pendingRefundGross(): bigint {
    return this.store.db.prepare('SELECT gross FROM credit_refunds WHERE transaction_hash IS NULL').all()
      .reduce((total, row) => total + quantity(row.gross, true), 0n)
  }
  accountedNotes(): AccountedNote[] {
    this.assertPrivateCredit()
    return this.store.db.prepare(`SELECT tree,position,commitment,transaction_hash AS transactionHash,
      block_number AS blockNumber,block_hash AS blockHash,amount FROM credit_deposits UNION ALL
      SELECT tree,position,commitment,transaction_hash AS transactionHash,block_number AS blockNumber,
      block_hash AS blockHash,amount FROM credit_owner_change`).all() as unknown as AccountedNote[]
  }
  ownerIntent(key: string): OwnerIntent | undefined {
    return this.store.db.prepare('SELECT * FROM credit_owner_intents WHERE key=?').get(hash(key)) as unknown as OwnerIntent | undefined
  }
  pendingOwnerIntent(): OwnerIntent | undefined {
    return this.store.db.prepare(`SELECT i.* FROM credit_owner_intents i LEFT JOIN credit_owner_settlements s
      ON s.intent_key=i.key WHERE s.intent_key IS NULL`).get() as unknown as OwnerIntent | undefined
  }
  ownerPayouts(key: string): RefundPayout[] {
    return this.store.db.prepare(`SELECT transaction_hash,block_number,block_hash FROM credit_owner_candidates c WHERE intent_key=?
      AND NOT EXISTS(SELECT 1 FROM credit_owner_rejections r WHERE r.transaction_hash=c.transaction_hash)
      AND NOT EXISTS(SELECT 1 FROM credit_owner_unrelated_rejections r WHERE r.transaction_hash=c.transaction_hash)`)
      .all(hash(key)) as unknown as RefundPayout[]
  }
  ownerSettlements(): RefundPayout[] {
    return this.store.db.prepare('SELECT transaction_hash,block_number,block_hash FROM credit_owner_settlements ORDER BY rowid').all() as unknown as RefundPayout[]
  }
  assertOwnerJournalReady(): void {
    this.store.assertCreditJournalActive()
    if (this.pendingOwnerIntent() || this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get('creditOwnerRecoveryRequired'))
      throw new Error('Resolve the saved owner payment before operator spending.')
    if (this.store.db.prepare(`SELECT 1 FROM credit_refunds r WHERE r.transaction_hash IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM credit_owner_intents i JOIN credit_owner_settlements s ON s.intent_key=i.key WHERE i.refund_key=r.key)`).get())
      throw new Error('Earlier owner payouts need exact debit reconciliation before operator spending.')
  }
  /** Stopped-service owner CLI: freezes admission before any external wallet signs. */
  prepareOwnerOperation(input: { kind: 'refund' | 'collection'; refundKey?: string; maximumPrivateFee: bigint;
    minimumNative: bigint; inputLimit: number; outputLimit: number; proofLimit: number; marginBps: bigint;
    collectionFees?: { unshieldFeeBps: bigint; gatewayFeeBps: bigint } }, proof: CreditBacking): OwnerIntent {
    this.assertPrivateCredit()
    quantity(input.maximumPrivateFee.toString()); quantity(input.minimumNative.toString())
    if (!['refund', 'collection'].includes(input.kind) || !Number.isSafeInteger(input.inputLimit) || input.inputLimit < 1 || input.inputLimit > 2 ||
      !Number.isSafeInteger(input.outputLimit) || input.outputLimit < 1 || input.outputLimit > 4 ||
      !Number.isSafeInteger(input.proofLimit) || input.proofLimit < 1 || input.proofLimit > 2 ||
      input.marginBps <= 0n || input.marginBps > 10_000n) throw new Error('Invalid bounded owner payment policy.')
    return this.atomic(() => {
      this.assertOwnerJournalReady()
      if (this.store.hasPending() || this.store.db.prepare('SELECT 1 FROM credit_attempts WHERE charged IS NULL').get())
        throw new Error('Settle every operator attempt before preparing an owner payment.')
      const key = hexlify(randomBytes(32)), refund = input.refundKey ? this.refund(input.refundKey) : undefined
      const earnings = this.earned()
      const backing = creditBackingEvidence(proof)
      if (backing.maximumInputs !== input.inputLimit || backing.available < this.requiredBacking() ||
        backing.bounded < earnings + this.pendingRefundGross())
        throw new Error('Canonical accounted backing must secure the owner payment before signing.')
      let debit: bigint
      if (input.kind === 'refund') {
        if (!refund || refund.transaction_hash || samePrivateIdentity(refund.recipient, this.scope.recipient) || input.minimumNative !== 0n ||
          input.maximumPrivateFee > quantity(refund.gross) - quantity(refund.net))
          throw new Error('The refund fee must cover its owner payout cost.')
        debit = quantity(refund.net) + input.maximumPrivateFee
      } else {
        if (input.refundKey || earnings <= input.maximumPrivateFee || input.minimumNative <= 0n || input.minimumNative > earnings - input.maximumPrivateFee)
          throw new Error('A collection must use all positive earned value and retain its approved native recovery.')
        const fees = input.collectionFees
        if (!fees || fees.unshieldFeeBps < 0n || fees.unshieldFeeBps > 5000n || fees.gatewayFeeBps !== ANON_COLLECTION_BASE_FEE_BPS)
          throw new Error('Current verified collection fees are required before an owner intent.')
        const gross = earnings - input.maximumPrivateFee
        const poolNet = gross - gross * fees.unshieldFeeBps / 10_000n
        const native = poolNet - poolNet * fees.gatewayFeeBps / 10_000n
        if (input.minimumNative > native)
          throw new Error('The collection minimum exceeds proceeds after the approved maximum private fee and current protocol fees.')
        debit = earnings
      }
      const sum = (sql: string) => this.store.db.prepare(sql).all().reduce((total, row) => total + quantity(row.amount), 0n)
      const gas = sum(`SELECT r.actual_cost AS amount FROM requests r JOIN credit_attempts a ON a.key=r.key
        WHERE a.charged IS NOT NULL`) - sum('SELECT gas_recovered AS amount FROM credit_owner_settlements')
      const fees = sum('SELECT private_fee AS amount FROM credit_owner_settlements') - sum('SELECT prior_fees_covered AS amount FROM credit_owner_settlements')
      if (gas < 0n || fees < 0n) throw new Error('Owner recovery accounting is inconsistent.')
      // Private fees have already left earned value; collect native gas reimbursement plus profit, not those fees a second time.
      const minimum = gas + ((gas + fees + input.maximumPrivateFee) * input.marginBps + 9_999n) / 10_000n
      if (input.kind === 'collection' && input.minimumNative < minimum)
        throw new Error('Native collection must cover unrecovered expenses and margin.')
      this.store.db.prepare(`INSERT INTO credit_owner_intents(key,ledger_id,kind,refund_key,debit,maximum_private_fee,
        minimum_native,gas_to_recover,prior_private_fees,input_limit,margin_bps,output_limit,proof_limit,created) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(key, this.id, input.kind, refund?.key ?? null, debit.toString(), input.maximumPrivateFee.toString(), input.minimumNative.toString(),
          gas.toString(), fees.toString(), input.inputLimit, Number(input.marginBps), input.outputLimit, input.proofLimit, Date.now())
      return this.ownerIntent(key)!
    })
  }
  recordOwnerPayout(key: string, receipt: TransactionReceipt): void {
    this.assertPrivateCredit()
    key = hash(key)
    const evidence = finalizedCreditEvidence(receipt)
    this.atomic(() => {
      this.store.assertCreditJournalActive()
      const intent = this.ownerIntent(key)
      if (!intent || intent.ledger_id !== this.id || evidence.status !== 1 || this.pendingOwnerIntent()?.key !== key)
        throw new Error('Select the saved unpaid owner intent and a successful finalized payout.')
      const previous = this.ownerPayouts(key).find((entry) => entry.transaction_hash === evidence.hash)
      if (previous) {
        if (previous.block_hash !== evidence.blockHash || previous.block_number !== evidence.blockNumber)
          throw new Error('Owner payout candidate changed canonical evidence.')
        return
      }
      if (this.ownerPayouts(key).length) throw new Error('The existing owner payout outcome must be resolved first.')
      this.store.db.prepare('INSERT INTO credit_owner_candidates(intent_key,transaction_hash,block_number,block_hash) VALUES(?,?,?,?)')
        .run(key, evidence.hash, evidence.blockNumber, evidence.blockHash)
    })
  }
  /** Reject only no-pool spends or complete-view-wallet evidence that no owned input was consumed; retain the intent. */
  rejectOwnerPayout(key: string, receipt: TransactionReceipt, unrelated?: VerifiedUnrelatedOwnerPayout): void {
    this.assertPrivateCredit()
    key = hash(key)
    const evidence = finalizedCreditEvidence(receipt)
    if (!Array.isArray(receipt.logs) || receipt.logs.length > 1024) throw new Error('Canonical owner payout logs are required.')
    let privateSpend = false
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(NETWORK.proxyContract)) continue
      if (log.removed || log.transactionHash !== evidence.hash || log.blockNumber !== evidence.blockNumber || log.blockHash !== evidence.blockHash)
        throw new Error('The owner payout logs changed canonical evidence.')
      if (PROXY.parseLog(log)?.name === 'Nullified') privateSpend = true
    }
    this.atomic(() => {
      this.store.assertCreditJournalActive()
      const intent = this.pendingOwnerIntent(), candidate = this.ownerPayouts(key).find((row) => row.transaction_hash === evidence.hash)
      if (intent?.key !== key || !candidate || evidence.status !== 1 || candidate.block_number !== evidence.blockNumber || candidate.block_hash !== evidence.blockHash)
        throw new Error('Select the active owner candidate with unchanged finalized evidence.')
      if (privateSpend) {
        if (!unrelated) throw new Error('A payout that spent private inputs needs exact owner reconciliation; it cannot be dismissed.')
        assertUnrelatedOwnerPayout(unrelated, receipt, this.scope, this.accountedNotes())
      }
      const table = privateSpend ? 'credit_owner_unrelated_rejections' : 'credit_owner_rejections'
      this.store.db.prepare(`INSERT INTO ${table}(transaction_hash,intent_key,block_number,block_hash,reason) VALUES(?,?,?,?,?)`)
        .run(evidence.hash, key, evidence.blockNumber, evidence.blockHash, privateSpend ? 'no-fee-wallet-nullifiers' : 'no-pool-nullifiers')
    })
  }
  private recordOwnerSettlement(intent: OwnerIntent, proof: VerifiedOwnerDebit, privateFee: bigint, unshieldGross: bigint,
    nativeReceived: bigint): void {
    const debit = ownerDebitEvidence(proof)
    if (intent.ledger_id !== this.id || !this.ownerPayouts(intent.key).some((entry) => entry.transaction_hash === debit.transactionHash &&
      entry.block_hash === debit.blockHash && entry.block_number === debit.blockNumber) || privateFee < 0n ||
      privateFee > quantity(intent.maximum_private_fee) || debit.inputs.length > intent.input_limit)
      throw new Error('Owner payout does not match its saved intent and exact fee cap.')
    for (const output of debit.change) {
      if (this.store.db.prepare('SELECT 1 FROM credit_deposits WHERE tree=? AND position=?').get(output.tree, output.position))
        throw new Error('An already credited deposit cannot also become owner change.')
    }
    this.store.db.prepare(`INSERT INTO credit_owner_settlements(intent_key,transaction_hash,block_number,block_hash,debit,private_fee,
      unshield_gross,native_received,gas_recovered,prior_fees_covered,inputs) VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
      .run(intent.key, debit.transactionHash, debit.blockNumber, debit.blockHash, debit.debit.toString(), privateFee.toString(),
        unshieldGross.toString(), nativeReceived.toString(), intent.kind === 'collection' ? intent.gas_to_recover : '0',
        intent.kind === 'collection' ? (quantity(intent.prior_private_fees) + privateFee).toString() : '0', JSON.stringify(debit.inputs))
    for (const output of debit.change) this.store.db.prepare(`INSERT INTO credit_owner_change(tree,position,commitment,
      transaction_hash,block_number,block_hash,amount,intent_key) VALUES(?,?,?,?,?,?,?,?)`)
      .run(output.tree, output.position, output.commitment, output.transactionHash, output.blockNumber, output.blockHash, output.amount, intent.key)
  }
  settleOwnerCollection(key: string, payment: ConfirmedCollection): void {
    this.assertPrivateCredit()
    key = hash(key)
    this.atomic(() => {
      this.store.assertCreditJournalActive()
      const intent = this.ownerIntent(key), debit = ownerDebitEvidence(payment.debit), native = nativeCollectionEvidence(payment.native)
      const backing = creditBackingEvidence(payment.backing)
      if (!intent || intent.kind !== 'collection' || this.pendingOwnerIntent()?.key !== key ||
        native.transactionHash !== debit.transactionHash || native.blockHash !== debit.blockHash || native.blockNumber !== debit.blockNumber ||
        getAddress(native.recipient) !== this.scope.operator || native.nativeReceived < quantity(intent.minimum_native) ||
        debit.debit !== quantity(intent.debit) || debit.debit !== this.earned() || backing.maximumInputs !== intent.input_limit ||
        backing.available < this.liability() || backing.bounded < this.pendingRefundGross())
        throw new Error('The exact full-earned collection is not verified or would spend customer backing.')
      this.recordOwnerSettlement(intent, payment.debit, debit.debit - native.grossUnshield, native.grossUnshield, native.nativeReceived)
      if (this.earned() !== 0n) throw new Error('Full-earned collection did not close its accounting.')
    })
  }
  attempt(key: string): AttemptRow | undefined {
    return this.store.db.prepare('SELECT * FROM credit_attempts WHERE key=?').get(hash(key)) as AttemptRow | undefined
  }
  refund(key: string): CreditRefundRow | undefined {
    return this.store.db.prepare('SELECT * FROM credit_refunds WHERE key=?').get(hash(key)) as CreditRefundRow | undefined
  }
  private currentSequence(owner: string): number {
    const row = this.store.db.prepare('SELECT sequence FROM credit_owner_sequences WHERE owner=?').get(owner)
    return row ? creditSequence(row.sequence) : 0
  }
  nextSequence(rawOwner: string): number {
    return creditSequence(this.currentSequence(ownerAddress(rawOwner)) + 1)
  }
  private advanceSequence(owner: string, sequence: number): void {
    const current = this.currentSequence(owner)
    if (creditSequence(sequence) !== current + 1) throw new Error('The prepaid request sequence is already consumed or not next.')
    if (current === 0) {
      if (!this.hasDeposit(owner))
        throw new Error('Confirmed prepaid deposit history is required to advance a request sequence.')
      this.store.db.prepare('INSERT INTO credit_owner_sequences(owner,sequence) VALUES(?,?)').run(owner, sequence)
    } else this.store.db.prepare('UPDATE credit_owner_sequences SET sequence=? WHERE owner=?').run(sequence, owner)
  }
  /** One durable owner counter fences late admissions without storing each rejected payload. */
  retireUnreserved(key: string, rawOwner: string, operation: 'execute' | 'refund', rawSequence?: unknown): false | { sequence: number | null; retiredThrough: number } {
    key = hash(key)
    const owner = ownerAddress(rawOwner)
    const sequence = rawSequence === undefined ? null : creditSequence(rawSequence)
    if (operation !== 'execute' && operation !== 'refund') throw new Error('Invalid prepaid recovery operation.')
    return this.atomic(() => {
      this.store.assertCreditJournalActive()
      const attempt = this.attempt(key), request = this.store.get(key), refund = this.refund(key), nativeRefund = this.nativeRefund(key)
      const retired = this.store.db.prepare('SELECT owner,operation FROM credit_retired_requests WHERE key=?').get(key)
      if (attempt || request || refund) {
        if (retired) throw new Error('A retired request has inconsistent reserved state.')
        if (attempt?.owner === owner && request && !refund &&
          (operation === 'execute' ? !nativeRefund : !!nativeRefund)) {
          const proof = JSON.parse(request.fee_data)
          if (proof.kind === 'prepaid' && proof.ledgerId === this.id && proof.owner === owner) return false
        }
        if (operation === 'refund' && refund?.owner === owner && !attempt && !request) return false
        throw new Error('The saved request does not match its prepaid recovery identity.')
      }
      if (retired) {
        if (retired.owner !== owner || retired.operation !== operation) throw new Error('The retired request identity changed.')
      }
      let retiredThrough = this.currentSequence(owner)
      // Unsequenced new admissions are permanently disabled, so legacy absence needs no write.
      if (sequence !== null && sequence > retiredThrough) {
        this.advanceSequence(owner, sequence)
        retiredThrough = sequence
      }
      return { sequence, retiredThrough }
    })
  }
  private assertNotRetired(key: string): void {
    if (this.store.db.prepare('SELECT 1 FROM credit_retired_requests WHERE key=?').get(key))
      throw new Error('This prepaid request was retired before reservation.')
  }
  refundPayouts(key: string): RefundPayout[] {
    return this.store.db.prepare('SELECT transaction_hash,block_number,block_hash FROM credit_refund_payouts WHERE refund_key=?')
      .all(hash(key)) as unknown as RefundPayout[]
  }
  refundCommitmentAvailable(key: string, commitment: string): boolean {
    return !this.store.db.prepare('SELECT 1 FROM credit_refunds WHERE commitment=? AND key<>?')
      .get(hash(commitment), hash(key))
  }
  /** Privileged stopped-service CLI only; public requests cannot assign an owner payout. */
  recordRefundPayout(key: string, receipt: TransactionReceipt): void {
    this.assertPrivateCredit()
    key = hash(key)
    const evidence = finalizedCreditEvidence(receipt)
    const intent = this.pendingOwnerIntent()
    if (!intent || intent.kind !== 'refund' || intent.refund_key !== key)
      throw new Error('Prepare the owner refund intent before signing its payout.')
    this.recordOwnerPayout(intent.key, receipt)
    this.atomic(() => {
      this.store.assertCreditJournalActive()
      const refund = this.refund(key)
      const previous = this.refundPayouts(key).find((payout) => payout.transaction_hash === evidence.hash)
      if (!refund || evidence.status !== 1 || (refund.transaction_hash !== null && !previous))
        throw new Error('Select an unpaid refund and a successful finalized owner payout.')
      if (previous) {
        if (previous.block_hash !== evidence.blockHash || previous.block_number !== evidence.blockNumber)
          throw new Error('The assigned refund payout changed canonical evidence.')
        return
      }
      this.store.db.prepare('INSERT INTO credit_refund_payouts(refund_key,transaction_hash,block_number,block_hash,created) VALUES(?,?,?,?,?)')
        .run(key, evidence.hash, evidence.blockNumber, evidence.blockHash, Date.now())
    })
  }
  assertChainNonce(nonce: number): void {
    this.store.assertCreditJournalActive()
    const row = this.store.db.prepare('SELECT MAX(nonce) AS maximum FROM requests').get()
    const nextRecorded = row?.maximum == null ? this.initialNonce : Number(row.maximum) + 1
    if (!Number.isSafeInteger(nonce) || nonce < this.initialNonce || nonce > Math.max(this.initialNonce, nextRecorded))
      throw new Error('Operator nonce exceeds this credit journal. Recover the missing journal before spending.')
  }
  reserve(attempt: CreditAttempt): void {
    const key = hash(attempt.key), owner = ownerAddress(attempt.owner), tx = Transaction.from(attempt.unsigned)
    const refund = attempt.nativeRefund
    if (refund && (!this.isNative || ![0,2].includes(tx.type ?? -1) || !tx.to || tx.data !== '0x' ||
      getAddress(tx.to) !== ownerAddress(refund.recipient) || getAddress(tx.to) === this.scope.operator ||
      tx.value !== quantity(refund.net.toString(),true) || (tx.authorizationList?.length ?? 0))) throw new Error('Invalid native refund reservation.')
    if (this.isNative && attempt.collectionAllowance !== 0n) throw new Error('Native prepaid attempts have no private collection allowance.')
    if (![0, 1, 2, 4].includes(tx.type ?? -1) || tx.isSigned() || tx.unsignedSerialized !== attempt.unsigned || tx.chainId !== BigInt(this.scope.chainId) ||
      tx.nonce !== attempt.nonce || !Number.isSafeInteger(attempt.nonce) || attempt.nonce < 0 || tx.value !== (refund?.net ?? 0n) ||
      attempt.gasBudget <= 0n || tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) !== attempt.gasBudget ||
      !Number.isSafeInteger(attempt.expiration) || attempt.expiration <= Date.now() ||
      attempt.maximumCharge < (refund?.net ?? 0n) + creditCharge(attempt.gasBudget, attempt.rate, attempt.collectionAllowance))
      throw new Error('Invalid prepaid attempt reservation.')
    const maximum = quantity(attempt.maximumCharge.toString(), true)
    quantity(attempt.rate.toString(), true); quantity(attempt.collectionAllowance.toString())
    this.atomic(() => {
      this.assertChainNonce(attempt.nonce)
      this.assertOwnerJournalReady()
      if (this.isNative) {
        if (this.hasUnsettledNativeAttempt())
          throw new Error('Finalize the outstanding native attempt before another signature.')
        this.assertNativeBacked(attempt.backing as NativeCreditBacking, attempt.nativeReserve ?? 0n, attempt.nonce)
      } else {
        const backing = creditBackingEvidence(attempt.backing as CreditBacking)
        if (backing.available < this.requiredBacking() || backing.bounded < this.earned() + this.maximumPendingCharges() + this.pendingRefundGross() + maximum)
          throw new Error('Accounted backing changed before reservation.')
      }
      this.assertNotRetired(key)
      if (this.store.get(key) || this.attempt(key)) throw new Error('This prepaid attempt is already reserved.')
      const pilotKey = withdrawalPilotKey(this.id, attempt.prepaidPilotLedgerId)
      if (attempt.withdrawalPilot && this.store.db.prepare('SELECT 1 FROM settings WHERE key=?').get(pilotKey))
        throw new Error('The withdrawal pilot is already used.')
      if (this.store.hasPending() || this.store.nonceBlocked(attempt.nonce)) throw new Error('Reconcile the existing operator reservation first.')
      if (this.store.exposure() + attempt.gasBudget > attempt.dailyBudget) throw new Error('Operator rolling gas budget exhausted.')
      if (this.balance(owner).available < maximum) throw new Error('Confirmed fee credit is insufficient.')
      this.advanceSequence(owner, attempt.sequence)
      const now = Date.now()
      this.store.db.prepare(`INSERT INTO credit_attempts(key,owner,unsigned,maximum_charge,rate,collection_allowance,sequence)
        VALUES(?,?,?,?,?,?,?)`).run(key, owner, attempt.unsigned, maximum.toString(), attempt.rate.toString(), attempt.collectionAllowance.toString(), attempt.sequence)
      this.store.db.prepare(`INSERT INTO requests(key,envelope,created,max_cost,signed_at,fee_data,nonce,fee_expiration)
        VALUES(?,?,?,?,?,?,?,?)`).run(key, attempt.envelope, now, attempt.gasBudget.toString(), now,
        JSON.stringify({ kind: 'prepaid', ledgerId: this.id, owner, sequence: attempt.sequence }), attempt.nonce, attempt.expiration)
      if (refund) this.store.db.prepare('INSERT INTO credit_native_refund_attempts(key,recipient,net) VALUES(?,?,?)')
        .run(key,ownerAddress(refund.recipient),refund.net.toString())
      if (attempt.withdrawalPilot) this.store.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(pilotKey, key)
    })
  }
  attachSignature(key: string, raw: string): string {
    key = hash(key)
    const tx = Transaction.from(raw)
    if (!tx.isSigned() || tx.serialized !== raw || tx.from !== this.scope.operator) throw new Error('Invalid prepaid operator signature.')
    return this.atomic(() => {
      const attempt = this.attempt(key), request = this.store.get(key)
      if (!attempt || !request || attempt.charged !== null || request.confirmed || tx.unsignedSerialized !== attempt.unsigned)
        throw new Error('The signed transaction differs from its reserved attempt.')
      if (request.raw !== null && (request.raw !== raw || request.hash !== tx.hash)) throw new Error('The attempt already has different signed bytes.')
      this.store.db.prepare('UPDATE requests SET raw=?,hash=? WHERE key=?').run(raw, tx.hash!, key)
      return tx.hash!
    })
  }
  assertCancellationCovered(key: string, cost: bigint): void {
    const attempt = this.attempt(key), request = this.store.get(key), refund = this.nativeRefund(key)
    if (!attempt || !request || attempt.charged !== null || cost <= 0n || (!refund && cost > quantity(request.max_cost, true)) ||
      creditCharge(cost, quantity(attempt.rate, true), quantity(attempt.collection_allowance)) > quantity(attempt.maximum_charge, true) - (refund ? quantity(refund.net,true) : 0n))
      throw new Error('Cancellation exceeds its secured prepaid budget.')
  }
  observeInclusion(key: string, receipt: TransactionReceipt): void {
    this.atomic(() => {
      const attempt = this.attempt(key), request = this.store.get(key)
      const raw = request?.hash === receipt.hash ? request.raw : this.store.cancellations(key).find((tx) => tx.hash === receipt.hash)?.raw
      if (!attempt || !request || !raw || !isHexString(receipt.blockHash, 32) || !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < 0)
        throw new Error('Unknown prepaid inclusion.')
      if (attempt.charged !== null) return
      const tx = Transaction.from(raw)
      if (tx.hash !== receipt.hash || tx.from !== this.scope.operator || tx.nonce !== request.nonce || tx.chainId !== BigInt(this.scope.chainId) ||
        receipt.gasUsed <= 0n || receipt.gasUsed > tx.gasLimit || receipt.gasPrice <= 0n || receipt.gasPrice > (tx.maxFeePerGas ?? tx.gasPrice ?? 0n))
        throw new Error('Invalid prepaid inclusion cost.')
      // The nonce can advance before finality; the full gas/credit reservation must remain held.
      this.store.db.prepare('UPDATE requests SET confirmed=1,actual_cost=NULL,mined_at=NULL,fee_data=? WHERE key=?')
        .run(JSON.stringify({ kind: 'prepaid', ledgerId: this.id, owner: attempt.owner, includedHash: receipt.hash,
          includedBlock: receipt.blockNumber, includedBlockHash: receipt.blockHash }), key)
    })
  }
  forgetInclusion(key: string): void {
    this.atomic(() => {
      const attempt = this.attempt(key)
      if (!attempt || attempt.charged !== null) throw new Error('Finalized prepaid settlement cannot be undone.')
      this.store.db.prepare('UPDATE requests SET confirmed=0,actual_cost=NULL,mined_at=NULL,fee_data=? WHERE key=?')
        .run(JSON.stringify({ kind: 'prepaid', ledgerId: this.id, owner: attempt.owner }), key)
    })
  }
  settle(key: string, receipt: TransactionReceipt): bigint {
    const evidence = finalizedCreditEvidence(receipt)
    key = hash(key)
    const receiptHash = hash(evidence.hash), cost = evidence.gasUsed * evidence.gasPrice
    return this.atomic(() => {
      const attempt = this.attempt(key), request = this.store.get(key)
      const raw = request?.hash === receiptHash ? request.raw : this.store.cancellations(key).find((tx) => tx.hash === receiptHash)?.raw
      if (!attempt || !request || !raw) throw new Error('A known finalized transaction is required to settle credit.')
      const transaction = Transaction.from(raw)
      if (transaction.hash !== receiptHash || transaction.from !== this.scope.operator || transaction.chainId !== BigInt(this.scope.chainId) ||
        transaction.nonce !== request.nonce || evidence.gasUsed > transaction.gasLimit ||
        evidence.gasPrice > (transaction.maxFeePerGas ?? transaction.gasPrice ?? 0n))
        throw new Error('Finalized receipt does not match its secured transaction.')
      const refund = this.nativeRefund(key)
      const paid = refund && request.hash === receiptHash && evidence.status === 1 ? quantity(refund.net,true) : 0n
      const charged = quantity((paid + creditCharge(cost, quantity(attempt.rate, true), quantity(attempt.collection_allowance))).toString())
      if (cost > quantity(request.max_cost, true) || charged > quantity(attempt.maximum_charge, true))
        throw new Error('Confirmed cost exceeds secured credit.')
      if (attempt.charged !== null) {
        if (attempt.charged !== charged.toString() || attempt.settlement_hash !== receiptHash)
          throw new Error('Credit was already settled against another outcome.')
        return charged
      }
      this.store.db.prepare('UPDATE credit_attempts SET charged=?,settlement_hash=? WHERE key=?')
        .run(charged.toString(), receiptHash, key)
      if (refund) this.store.db.prepare(`INSERT INTO credit_native_refund_settlements(key,paid,transaction_hash,block_number,block_hash,status)
        VALUES(?,?,?,?,?,?)`).run(key,paid.toString(),receiptHash,evidence.blockNumber,evidence.blockHash,evidence.status)
      this.store.confirmed(key, cost, evidence.minedAt)
      this.store.db.prepare('UPDATE requests SET assured=1,fee_data=? WHERE key=?')
        .run(JSON.stringify({ kind: 'prepaid', ledgerId: this.id, owner: attempt.owner, charged: charged.toString(), receiptHash,
          blockNumber: evidence.blockNumber, blockHash: evidence.blockHash, status: evidence.status }), key)
      return charged
    })
  }
  hasPendingRefund(rawOwner: string): boolean {
    if (this.isNative) return !!this.store.db.prepare(`SELECT 1 FROM credit_native_refund_attempts r
      JOIN credit_attempts a ON a.key=r.key WHERE a.owner=? AND a.charged IS NULL LIMIT 1`).get(ownerAddress(rawOwner))
    return !!this.store.db.prepare('SELECT 1 FROM credit_refunds WHERE owner=? AND transaction_hash IS NULL LIMIT 1').get(ownerAddress(rawOwner))
  }
  refundExecutionHeadroom(rawOwner: string, maximumExecutionCharge: bigint): bigint {
    const owner = ownerAddress(rawOwner)
    quantity(maximumExecutionCharge.toString(), true)
    const available = new Map<string, bigint>()
    const add = (claimant: unknown, value: bigint) => {
      const address = ownerAddress(String(claimant))
      available.set(address, (available.get(address) ?? 0n) + value)
    }
    // Three linear passes preserve exact 256-bit arithmetic without a balance query for each claimant.
    for (const row of this.store.db.prepare('SELECT owner,amount FROM credit_deposits WHERE owner<>?').all(owner))
      add(row.owner, quantity(row.amount, true))
    for (const row of this.store.db.prepare('SELECT owner,maximum_charge,charged FROM credit_attempts WHERE owner<>?').all(owner)) {
      const maximum = quantity(row.maximum_charge, true), charge = row.charged === null ? maximum : quantity(row.charged)
      if (charge > maximum) throw new Error('Credit settlement exceeds its reservation.')
      add(row.owner, -charge)
    }
    for (const row of this.store.db.prepare('SELECT owner,gross FROM credit_refunds WHERE owner<>?').all(owner))
      add(row.owner, -quantity(row.gross, true))
    if ([...available.values()].some((balance) => balance < 0n)) throw new Error('Credit ledger is inconsistent.')
    if ([...available.values()].some((balance) => balance >= maximumExecutionCharge)) return maximumExecutionCharge
    return 0n
  }
  reserveRefund(key: string, rawOwner: string, recipient: string, gross: bigint, net: bigint, sequence: number,
    proof: CreditBacking, maximumExecutionCharge: bigint): void {
    this.assertPrivateCredit()
    key = hash(key)
    const owner = ownerAddress(rawOwner)
    quantity(gross.toString(), true); quantity(net.toString(), true); quantity(maximumExecutionCharge.toString(), true)
    if (!validateRailgunAddress(recipient) || samePrivateIdentity(recipient, this.scope.recipient) || net > gross) throw new Error('Invalid credit refund.')
    this.atomic(() => {
      this.store.assertCreditJournalActive()
      this.assertNotRetired(key)
      const previous = this.store.db.prepare('SELECT * FROM credit_refunds WHERE key=?').get(key)
      if (previous) {
        if (previous.owner !== owner || previous.recipient !== recipient || previous.gross !== gross.toString() || previous.net !== net.toString())
          throw new Error('Refund request identity changed.')
        return
      }
      this.assertOwnerJournalReady()
      if (this.hasPendingRefund(owner)) throw new Error('Resolve this owner’s pending refund before reserving another.')
      const backing = creditBackingEvidence(proof)
      if (backing.available < this.requiredBacking() ||
        backing.bounded < this.earned() + this.maximumPendingCharges() + this.pendingRefundGross() + gross + this.refundExecutionHeadroom(owner, maximumExecutionCharge))
        throw new Error('Refund exceeds the currently recoverable amount; request a smaller partial refund.')
      if (this.balance(owner).available < gross) throw new Error('Unused confirmed credit is insufficient for this refund.')
      this.advanceSequence(owner, sequence)
      this.store.db.prepare('INSERT INTO credit_refunds(key,owner,recipient,gross,net,created,sequence) VALUES(?,?,?,?,?,?,?)')
        .run(key, owner, recipient, gross.toString(), net.toString(), Date.now(), sequence)
    })
  }
  settleRefund(key: string, payment: ConfirmedRefund): void {
    this.assertPrivateCredit()
    const receipt = finalizedCreditEvidence(payment.receipt)
    key = hash(key)
    const transactionHash = hash(receipt.hash), commitment = hash(payment.commitment)
    this.atomic(() => {
      const refund = this.store.db.prepare('SELECT * FROM credit_refunds WHERE key=?').get(key)
      const ownerAssigned = this.refundPayouts(key).some((payout) => payout.transaction_hash === transactionHash &&
        payout.block_hash === receipt.blockHash && payout.block_number === receipt.blockNumber)
      const matchingMemo = payment.memo === creditRefundMemo(this.scope, this.id, key)
      const assignedWithoutMemo = ownerAssigned && (payment.memo === undefined || payment.memo === '')
      if (!refund || receipt.status !== 1 || refund.recipient !== payment.recipient || refund.net !== payment.amount.toString() ||
        getAddress(payment.token) !== this.scope.token || !ownerAssigned || (!matchingMemo && !assignedWithoutMemo) ||
        (refund.transaction_hash !== null && (refund.transaction_hash !== transactionHash || refund.commitment !== commitment ||
          refund.block_hash !== receipt.blockHash || refund.block_number !== receipt.blockNumber)))
        throw new Error('Missing or already settled refund.')
      if (!this.refundCommitmentAvailable(key, commitment))
        throw new Error('That refund commitment was already used.')
      if (refund.transaction_hash !== null) return
      const intent = this.pendingOwnerIntent()
      if (!intent || intent.kind !== 'refund' || intent.refund_key !== key || !payment.debit || !payment.backing)
        throw new Error('The refund needs its saved owner intent and exact verified debit.')
      const debit = ownerDebitEvidence(payment.debit), backing = creditBackingEvidence(payment.backing)
      if (debit.transactionHash !== transactionHash || debit.blockHash !== receipt.blockHash || debit.blockNumber !== receipt.blockNumber ||
        debit.debit > quantity(intent.debit) || backing.maximumInputs !== intent.input_limit)
        throw new Error('The verified refund debit exceeds its saved owner intent.')
      const privateFee = debit.debit - payment.amount
      this.recordOwnerSettlement(intent, payment.debit, privateFee, 0n, 0n)
      this.store.db.prepare('UPDATE credit_refunds SET transaction_hash=?,commitment=?,block_hash=?,block_number=? WHERE key=?')
        .run(transactionHash, commitment, receipt.blockHash, receipt.blockNumber, key)
      if (backing.available < this.requiredBacking() || backing.bounded < this.earned() + this.pendingRefundGross())
        throw new Error('Refund payout did not preserve customer backing and bounded earned recovery.')
    })
  }
}
