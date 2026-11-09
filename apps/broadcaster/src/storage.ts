import { lstatSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAddress, randomBytes, Mnemonic, Transaction, Wallet, ZeroAddress } from 'ethers'
import { parseSecrets, privateDirectory, privateFile, type Secrets } from './secrets'

export { parseMainnetSecrets, parseSecrets, privateDirectory, privateFile, type Secrets } from './secrets'

export function assertDisk(path: string): void {
  const fs = statfsSync(path)
  if (fs.bavail * fs.bsize < 6 * 1024 ** 3) throw new Error('Operator storage has less than 6 GiB free.')
}

export function initializeSecrets(path: string, mode: 'fork' | 'mainnet'): string {
  if (mode !== 'fork') throw new Error('File-based wallet initialization is restricted to disposable fork tests. Create production keys outside the broadcaster.')
  privateDirectory(dirname(path))
  const wallet = Wallet.createRandom()
  const secrets: Secrets = { gasKey: wallet.privateKey,
    feeMnemonic: Mnemonic.fromEntropy(randomBytes(32)).phrase,
    encryptionKey: Buffer.from(randomBytes(32)).toString('hex') }
  writeFileSync(path, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 })
  return wallet.address
}

export function readSecrets(path: string): Secrets {
  try {
    return parseSecrets(privateFile(path))
  } catch { throw new Error('Invalid or inaccessible operator secrets; no secret values were logged.') }
}

export interface RequestRecord {
  key: string; envelope: string; raw: string | null; hash: string | null
  response: string | null; confirmed: number; assured: number
  max_cost: string; actual_cost: string | null; signed_at: number; mined_at: number | null
  fee_data: string
  nonce: number
  cancel_raw: string | null; cancel_hash: string | null
  checked_at: number; fee_expiration: number
}

export class Store {
  readonly db: DatabaseSync
  constructor(private readonly path: string) {
    privateDirectory(path)
    const file = join(path, 'requests.sqlite')
    privateFile(file, true)
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS requests (
        key TEXT PRIMARY KEY, envelope TEXT NOT NULL, raw TEXT, hash TEXT, response TEXT,
        confirmed INTEGER NOT NULL DEFAULT 0, assured INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL,
        max_cost TEXT NOT NULL, actual_cost TEXT, signed_at INTEGER NOT NULL, mined_at INTEGER,
        fee_data TEXT NOT NULL, nonce INTEGER NOT NULL, cancel_raw TEXT, cancel_hash TEXT,
        checked_at INTEGER NOT NULL DEFAULT 0, fee_expiration INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS fees (id TEXT PRIMARY KEY, expiration INTEGER NOT NULL, rates TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settlement_resolutions (
        key TEXT PRIMARY KEY, hash TEXT NOT NULL, actual_cost TEXT NOT NULL,
        block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, reason TEXT NOT NULL, created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cancellation_history (
        key TEXT NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL, nonce INTEGER NOT NULL,
        PRIMARY KEY (key,hash)
      );
      INSERT INTO cancellation_history(key,hash,raw,nonce)
        SELECT key,cancel_hash,cancel_raw,nonce FROM requests r WHERE cancel_hash IS NOT NULL AND cancel_raw IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM cancellation_history h WHERE h.key=r.key AND h.hash=r.cancel_hash);
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_update BEFORE UPDATE ON cancellation_history
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_delete BEFORE DELETE ON cancellation_history
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_replace BEFORE INSERT ON cancellation_history
        WHEN EXISTS(SELECT 1 FROM cancellation_history WHERE key=NEW.key AND hash=NEW.hash)
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_resolution_update BEFORE UPDATE ON settlement_resolutions
        BEGIN SELECT RAISE(ABORT, 'Settlement resolutions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_resolution_delete BEFORE DELETE ON settlement_resolutions
        BEGIN SELECT RAISE(ABORT, 'Settlement resolutions are append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_identity_update BEFORE UPDATE ON settings
        WHEN OLD.key IN ('chainId','operatorAddress') OR NEW.key IN ('chainId','operatorAddress')
        BEGIN SELECT RAISE(ABORT, 'Operator identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_identity_delete BEFORE DELETE ON settings
        WHEN OLD.key IN ('chainId','operatorAddress')
        BEGIN SELECT RAISE(ABORT, 'Operator identity is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_identity_replace BEFORE INSERT ON settings
        WHEN NEW.key IN ('chainId','operatorAddress') AND EXISTS(SELECT 1 FROM settings WHERE key=NEW.key)
        BEGIN SELECT RAISE(ABORT, 'Operator identity is immutable'); END;`)
  }
  bindIdentity(chainId: number, operatorAddress?: string): void {
    const supported = (value: number) => [1, 42161, 56, 137].includes(value)
    if (!supported(chainId)) throw new Error('Unsupported operator journal network.')
    const requested = operatorAddress === undefined ? undefined : getAddress(operatorAddress)
    if (requested === ZeroAddress) throw new Error('Invalid operator journal identity.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const chain = this.db.prepare('SELECT value FROM settings WHERE key=?').get('chainId')
      const saved = this.db.prepare('SELECT value FROM settings WHERE key=?').get('operatorAddress')
      if ((chain && (typeof chain.value !== 'string' || !supported(Number(chain.value)) || String(Number(chain.value)) !== chain.value)) ||
        (saved && (!chain || typeof saved.value !== 'string' || getAddress(saved.value) !== saved.value || saved.value === ZeroAddress)))
        throw new Error('The persisted operator journal identity is corrupt.')
      if ((chain && chain.value !== String(chainId)) || (saved && requested && saved.value !== requested))
        throw new Error('The operator journal belongs to a different network or gas wallet.')
      if (!chain && chainId !== 1 && this.db.prepare(`SELECT 1 FROM requests UNION ALL SELECT 1 FROM fees
        UNION ALL SELECT 1 FROM settings UNION ALL SELECT 1 FROM settlement_resolutions
        UNION ALL SELECT 1 FROM cancellation_history LIMIT 1`).get())
        throw new Error('A populated legacy journal may only be bound to Ethereum.')
      let operator = requested ?? (saved?.value as string | undefined)
      for (const row of this.db.prepare(`SELECT key,raw,hash,nonce,nonce AS expected_nonce,fee_data,max_cost FROM requests
        UNION ALL SELECT key,cancel_raw,cancel_hash,nonce,nonce,NULL,NULL FROM requests WHERE cancel_raw IS NOT NULL OR cancel_hash IS NOT NULL
        UNION ALL SELECT h.key,h.raw,h.hash,h.nonce,r.nonce,NULL,NULL FROM cancellation_history h LEFT JOIN requests r ON h.key=r.key`).iterate()) {
        if (row.raw === null && row.hash === null) {
          const proof = JSON.parse(String(row.fee_data))
          if (proof.kind !== 'prepaid') throw new Error('The journal contains an incomplete signed transaction.')
          const reserved = this.db.prepare('SELECT owner,unsigned FROM credit_attempts WHERE key=?').get(row.key)
          const identity = this.db.prepare('SELECT id FROM credit_identity WHERE singleton=1').get()
          const unsigned = Transaction.from(String(reserved?.unsigned))
          if (!operator || !reserved || !identity || proof.kind !== 'prepaid' || proof.owner !== reserved.owner ||
            proof.ledgerId !== identity.id || unsigned.isSigned() || unsigned.unsignedSerialized !== reserved.unsigned ||
            unsigned.chainId !== BigInt(chainId) || unsigned.nonce !== row.nonce || row.nonce !== row.expected_nonce ||
            unsigned.value !== 0n || unsigned.gasLimit * (unsigned.maxFeePerGas ?? unsigned.gasPrice ?? 0n) !== BigInt(String(row.max_cost)))
            throw new Error('The journal contains an inconsistent prepaid reservation.')
          continue
        }
        let tx: Transaction
        try { tx = Transaction.from(String(row.raw)) } catch { throw new Error('The journal contains an invalid signed transaction.') }
        if (!tx.isSigned() || tx.serialized !== row.raw || tx.hash !== row.hash || tx.chainId !== BigInt(chainId) ||
          tx.nonce !== row.nonce || row.nonce !== row.expected_nonce || (operator && tx.from !== operator))
          throw new Error('The journal contains an inconsistent signed transaction.')
        operator ??= tx.from!
      }
      if (!chain) this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('chainId', String(chainId))
      if (!saved && operator) this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('operatorAddress', operator)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back. */ }
      throw error
    }
  }
  get(key: string): RequestRecord | undefined {
    return this.db.prepare('SELECT * FROM requests WHERE key=?').get(key) as RequestRecord | undefined
  }
  exposure(now = Date.now()): bigint {
    const rows = this.db.prepare('SELECT max_cost,actual_cost FROM requests WHERE COALESCE(mined_at,signed_at)>=? OR confirmed=0 OR actual_cost IS NULL')
      .all(now - 24 * 60 * 60_000) as { max_cost: string; actual_cost: string | null }[]
    return rows.reduce((sum, row) => sum + BigInt(row.actual_cost ?? row.max_cost), 0n)
  }
  signed(key: string, envelope: string, raw: string, hash: string, cost: bigint, budget: bigint, nonce: number, feeData = '{}', expiration = 0, withdrawalPilot = false): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid journal nonce.')
      if (this.get(key)) throw new Error('This request is already journaled.')
      if (withdrawalPilot && this.db.prepare('SELECT 1 FROM settings WHERE key=?').get('withdrawalPilot'))
        throw new Error('The withdrawal pilot is already used. Reconcile the saved transaction.')
      if (cost <= 0n || this.exposure() + cost > budget) throw new Error('Operator rolling 24-hour gas budget exhausted.')
      if (this.hasPending()) throw new Error('Reconcile the unresolved transaction and its fee before another reservation.')
      if (this.nonceBlocked(nonce)) throw new Error('The operator nonce was already reserved. Reconcile a chain rollback before new signing.')
      this.db.prepare('INSERT INTO requests(key,envelope,raw,hash,created,max_cost,signed_at,fee_data,nonce,fee_expiration) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(key, envelope, raw, hash, Date.now(), cost.toString(), Date.now(), feeData, nonce, expiration)
      if (withdrawalPilot) this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('withdrawalPilot', hash)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back. */ }
      throw error
    }
  }
  respond(key: string, encrypted: string): void {
    this.db.prepare('UPDATE requests SET response=? WHERE key=?').run(encrypted, key)
  }
  cancel(key: string, raw: string, hash: string, cost: bigint, budget: bigint): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const request = this.get(key)
      if (!request || request.confirmed) throw new Error('No unresolved request to cancel.')
      this.assertPrepaidCancellationCovered(key, cost)
      const oldCost = BigInt(request.max_cost), maxCost = oldCost > cost ? oldCost : cost
      if (this.exposure() + maxCost - oldCost > budget) throw new Error('Cancellation exceeds the rolling gas budget.')
      if (request.cancel_raw != null || request.cancel_hash != null) {
        if (!request.cancel_raw || !request.cancel_hash) throw new Error('The current cancellation record is incomplete.')
        this.retainCancellation(key, request.cancel_raw, request.cancel_hash, request.nonce)
      }
      const previous = this.db.prepare('SELECT raw,nonce FROM cancellation_history WHERE key=? AND hash=?').get(key, hash)
      if (previous && request.cancel_hash !== hash) throw new Error('An earlier cancellation cannot replace the latest retry target.')
      this.retainCancellation(key, raw, hash, request.nonce)
      this.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?,max_cost=? WHERE key=?')
        .run(raw, hash, maxCost.toString(), key)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Already rolled back. */ }
      throw error
    }
  }
  assertPrepaidCancellationCovered(key: string, cost: bigint): void {
    const request = this.get(key)
    if (!request || JSON.parse(request.fee_data).kind !== 'prepaid') return
    this.assertCreditJournalActive()
    const attempt = this.db.prepare('SELECT unsigned,charged FROM credit_attempts WHERE key=?').get(key)
    if (!attempt || attempt.charged !== null) throw new Error('Missing secured prepaid cancellation budget.')
    const original = Transaction.from(String(attempt.unsigned))
    const maximum = original.gasLimit * (original.maxFeePerGas ?? original.gasPrice ?? 0n)
    if (cost <= 0n || cost > maximum || BigInt(request.max_cost) !== maximum)
      throw new Error('Cancellation exceeds its secured prepaid budget.')
  }
  assertCreditJournalActive(): void {
    if (lstatSync(join(this.path, '.prepaid-restore-review-required'), { throwIfNoEntry: false }) ||
      this.db.prepare('SELECT 1 FROM settings WHERE key=?').get('creditRecoveryRequired'))
      throw new Error('Restored credit journal requires recovery review before any signing or refund reservation.')
  }
  private retainCancellation(key: string, raw: string, hash: string, nonce: number): void {
    const previous = this.db.prepare('SELECT raw,nonce FROM cancellation_history WHERE key=? AND hash=?').get(key, hash)
    if (previous) {
      if (previous.raw !== raw || previous.nonce !== nonce) throw new Error('The retained cancellation record is inconsistent.')
    } else this.db.prepare('INSERT INTO cancellation_history(key,hash,raw,nonce) VALUES(?,?,?,?)').run(key, hash, raw, nonce)
  }
  cancellations(key: string): { hash: string; raw: string; nonce: number }[] {
    const request = this.get(key)
    if (request && (request.cancel_raw != null || request.cancel_hash != null) && (!request.cancel_raw || !request.cancel_hash))
      throw new Error('The current cancellation record is incomplete.')
    if (this.db.prepare(`SELECT 1 FROM cancellation_history h LEFT JOIN requests r ON h.key=r.key
      WHERE h.key=? AND (r.key IS NULL OR h.nonce<>r.nonce OR (h.hash=r.cancel_hash AND h.raw<>r.cancel_raw)) LIMIT 1`).get(key))
      throw new Error('The retained cancellation record is inconsistent.')
    return this.db.prepare(`SELECT hash,raw,nonce FROM (
      SELECT cancel_hash AS hash,cancel_raw AS raw,nonce,1 AS current,0 AS sequence FROM requests
        WHERE key=? AND cancel_hash IS NOT NULL AND cancel_raw IS NOT NULL
      UNION ALL SELECT hash,raw,nonce,0,rowid FROM cancellation_history WHERE key=?
        AND hash IS NOT (SELECT cancel_hash FROM requests WHERE key=?)
      ) ORDER BY current DESC,sequence DESC`).all(key, key, key) as { hash: string; raw: string; nonce: number }[]
  }
  confirmed(key: string, cost: bigint, minedAt: number): void {
    this.db.prepare('UPDATE requests SET confirmed=1,actual_cost=?,mined_at=? WHERE key=?').run(cost.toString(), minedAt, key)
  }
  assured(key: string, received = false): void {
    const request = this.get(key)
    if (!request) throw new Error('Missing fee settlement record.')
    const proof = JSON.parse(request.fee_data)
    this.db.prepare('UPDATE requests SET assured=1,fee_data=? WHERE key=?')
      .run(JSON.stringify({ ...proof, settlement: received ? 'fee-received' : 'cancelled' }), key)
  }
  acknowledgeLoss(key: string, hash: string, cost: bigint, block: number, blockHash: string, reason: string): void {
    if (!/^[\x20-\x7e]{10,200}$/.test(reason)) throw new Error('A 10–200 character audit reason is required.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const request = this.get(key)
      if (request && JSON.parse(request.fee_data).kind === 'prepaid')
        throw new Error('Prepaid attempts require receipt settlement; a loss acknowledgement cannot release their reservation.')
      if (!request || request.confirmed !== 1 || request.assured !== 0 || request.hash !== hash ||
        request.actual_cost !== cost.toString() || cost <= 0n)
        throw new Error('The confirmed unpaid record changed; reconcile before acknowledging a loss.')
      this.db.prepare('INSERT INTO settlement_resolutions(key,hash,actual_cost,block_number,block_hash,reason,created) VALUES(?,?,?,?,?,?,?)')
        .run(key, hash, cost.toString(), block, blockHash, reason, Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Already rolled back. */ }
      throw error
    }
  }
  checked(key: string): void { this.db.prepare('UPDATE requests SET checked_at=? WHERE key=?').run(Date.now(), key) }
  pending(): RequestRecord[] {
    return this.db.prepare(`SELECT * FROM requests WHERE (confirmed=0 OR assured=0)
      AND NOT EXISTS (SELECT 1 FROM settlement_resolutions s WHERE s.key=requests.key AND s.hash=requests.hash
        AND s.actual_cost=requests.actual_cost AND requests.confirmed=1 AND requests.assured=0)
      ORDER BY confirmed,checked_at,created LIMIT 20`)
      .all() as unknown as RequestRecord[]
  }
  hasPending(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM requests WHERE (confirmed=0 OR assured=0)
      AND NOT COALESCE((confirmed=1 AND json_extract(fee_data,'$.kind')='prepaid' AND json_extract(fee_data,'$.includedHash') IS NOT NULL),0)
      AND NOT EXISTS (SELECT 1 FROM settlement_resolutions s WHERE s.key=requests.key AND s.hash=requests.hash
        AND s.actual_cost=requests.actual_cost AND requests.confirmed=1 AND requests.assured=0) LIMIT 1`).get()
  }
  nonceBlocked(nonce: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE nonce>=? LIMIT 1').get(nonce)
  }
  close(): void { this.db.close() }
}
