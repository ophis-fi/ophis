import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getAddress, randomBytes, Mnemonic, Transaction, Wallet, ZeroAddress } from 'ethers'

export function assertDisk(path: string): void {
  const fs = statfsSync(path)
  if (fs.bavail * fs.bsize < 6 * 1024 ** 3) throw new Error('Operator storage has less than 6 GiB free.')
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const s = lstatSync(path)
  if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077))
    throw new Error('Operator storage requires an owned private directory (0700).')
}

export function privateFile(path: string, create = false): Buffer {
  const fd = openSync(path, (create ? constants.O_RDWR | constants.O_CREAT : constants.O_RDONLY) |
    constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077))
      throw new Error('Operator files must be owned, private regular files (0600).')
    if (!create && s.size > 32 * 1024) throw new Error('Operator secrets exceed the size limit.')
    return create ? Buffer.alloc(0) : readFileSync(fd)
  } finally { closeSync(fd) }
}

export interface Secrets { gasKey: string; feeMnemonic?: string; feeViewingKey?: string; encryptionKey: string }

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

export function parseSecrets(data: Buffer): Secrets {
  try {
    if (data.length > 8192) throw new Error()
    const value = JSON.parse(data.toString()) as Secrets
    if (!value || Object.keys(value).some((key) => !['gasKey', 'encryptionKey', 'feeMnemonic', 'feeViewingKey'].includes(key)) ||
      typeof value.gasKey !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.gasKey) ||
      (value.feeMnemonic === undefined) === (value.feeViewingKey === undefined) ||
      (value.feeMnemonic !== undefined && (typeof value.feeMnemonic !== 'string' || !Mnemonic.isValidMnemonic(value.feeMnemonic))) ||
      (value.feeViewingKey !== undefined && (typeof value.feeViewingKey !== 'string' || !/^[0-9a-f]{128,1024}$/.test(value.feeViewingKey))) ||
      typeof value.encryptionKey !== 'string' || !/^[0-9a-f]{64}$/i.test(value.encryptionKey)) throw new Error()
    return value
  } catch { throw new Error('Invalid or inaccessible operator secrets; no secret values were logged.') }
}

export function parseMainnetSecrets(data: Buffer, operatorAddress: string): Secrets {
  const value = parseSecrets(data)
  if (!value.feeViewingKey || value.feeMnemonic || new Wallet(value.gasKey).address !== operatorAddress)
    throw new Error('The unlocked keys do not match the configured gas and view-only fee custody.')
  return value
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
  constructor(path: string) {
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
        UNION ALL SELECT 1 FROM settings UNION ALL SELECT 1 FROM settlement_resolutions LIMIT 1`).get())
        throw new Error('A populated legacy journal may only be bound to Ethereum.')
      let operator = requested ?? (saved?.value as string | undefined)
      for (const row of this.db.prepare('SELECT raw,hash,nonce,cancel_raw,cancel_hash FROM requests').iterate()) {
        const transactions = [[row.raw, row.hash]]
        if (row.cancel_raw != null || row.cancel_hash != null) transactions.push([row.cancel_raw, row.cancel_hash])
        for (const [raw, hash] of transactions) {
          let tx: Transaction
          try { tx = Transaction.from(String(raw)) } catch { throw new Error('The journal contains an invalid signed transaction.') }
          if (!tx.isSigned() || tx.serialized !== raw || tx.hash !== hash || tx.chainId !== BigInt(chainId) ||
            tx.nonce !== row.nonce || (operator && tx.from !== operator))
            throw new Error('The journal contains an inconsistent signed transaction.')
          operator ??= tx.from!
        }
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
    const rows = this.db.prepare('SELECT max_cost,actual_cost FROM requests WHERE COALESCE(mined_at,signed_at)>=? OR confirmed=0')
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
      const oldCost = BigInt(request.max_cost), maxCost = oldCost > cost ? oldCost : cost
      if (this.exposure() + maxCost - oldCost > budget) throw new Error('Cancellation exceeds the rolling gas budget.')
      this.db.prepare('UPDATE requests SET cancel_raw=?,cancel_hash=?,max_cost=? WHERE key=?')
        .run(raw, hash, maxCost.toString(), key)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Already rolled back. */ }
      throw error
    }
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
    return this.db.prepare(`SELECT * FROM requests WHERE hash IS NOT NULL AND (confirmed=0 OR assured=0)
      AND NOT EXISTS (SELECT 1 FROM settlement_resolutions s WHERE s.key=requests.key AND s.hash=requests.hash
        AND s.actual_cost=requests.actual_cost AND requests.confirmed=1 AND requests.assured=0)
      ORDER BY confirmed,checked_at,created LIMIT 20`)
      .all() as unknown as RequestRecord[]
  }
  hasPending(): boolean {
    return !!this.db.prepare(`SELECT 1 FROM requests WHERE hash IS NOT NULL AND (confirmed=0 OR assured=0)
      AND NOT EXISTS (SELECT 1 FROM settlement_resolutions s WHERE s.key=requests.key AND s.hash=requests.hash
        AND s.actual_cost=requests.actual_cost AND requests.confirmed=1 AND requests.assured=0) LIMIT 1`).get()
  }
  nonceBlocked(nonce: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM requests WHERE confirmed=0 AND nonce>=? LIMIT 1').get(nonce)
  }
  close(): void { this.db.close() }
}
