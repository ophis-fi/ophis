import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { FetchRequest, getAddress, JsonRpcProvider, Transaction, verifyAuthorization,
  type JsonRpcPayload, type JsonRpcResult, type JsonRpcError } from 'ethers'
import { assertExecutionGuardCode, decodeGuardedExecution } from './execution-guard'
import { assertBnbBundleUnexpired, createBnbBundle, protectedWriteRPC, readBnbBundle, submitProtected } from './protected-submission'
export { PROTECTED_WRITE_RPC, protectedWriteRPC } from './protected-submission'

const NETWORKS: Record<number, NetworkName | undefined> = {
  1: NetworkName.Ethereum, 42161: NetworkName.Arbitrum, 56: NetworkName.BNBChain, 137: NetworkName.Polygon,
}

const READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'web3_clientVersion', 'eth_blockNumber',
  'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash', 'eth_getTransactionByHash', 'eth_getTransactionReceipt',
  'eth_getTransactionCount', 'eth_getCode', 'eth_getBalance', 'eth_getStorageAt', 'eth_getLogs',
  'eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
  'debug_traceCall',
])
type Pending = { hash: string; nonce: number; raw: string; cancel_hash: string | null; cancel_raw: string | null }
type PendingSummary = { hash: string; nonce: number; cancellationHash?: string }

/** Node-only transport for an operator's existing, validated Railgun transaction sender. */
export class ProtectedEthereumProvider extends JsonRpcProvider {
  private readonly journal: DatabaseSync
  private readonly operator: string
  private forkCheck?: Promise<void>
  private readonly executionGuard?: string
  private readonly config: (typeof NETWORK_CONFIG)[NetworkName]

  constructor(readRPC: string | FetchRequest, operatorAddress: string, privateStateDirectory: string, executionGuard?: string,
    private readonly chainId = 1, private readonly nativeRefunds = false) {
    const network = Number.isSafeInteger(chainId) ? NETWORKS[chainId] : undefined
    if (!network) throw new Error('Unsupported protected operator chain.')
    super(readRPC, chainId, { batchMaxCount: 1, cacheTimeout: -1 })
    this.config = NETWORK_CONFIG[network]
    this.operator = getAddress(operatorAddress)
    this.executionGuard = executionGuard === undefined ? undefined : getAddress(executionGuard)
    mkdirSync(privateStateDirectory, { recursive: true, mode: 0o700 })
    const directory = lstatSync(privateStateDirectory)
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077))
      throw new Error('The operator journal needs an owned, private directory (0700).')
    const path = join(privateStateDirectory, 'protected-transactions.sqlite')
    const file = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.uid !== directory.uid || (stat.mode & 0o077))
        throw new Error('The operator journal must be a private file (0600).')
    } finally { closeSync(file) }
    this.journal = new DatabaseSync(path)
    try {
      this.journal.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
    `)
      this.journal.exec('BEGIN IMMEDIATE')
      this.journal.exec(`
      CREATE TABLE IF NOT EXISTS pending (
        operator TEXT PRIMARY KEY, hash TEXT NOT NULL, nonce INTEGER NOT NULL, raw TEXT NOT NULL,
        cancel_hash TEXT, cancel_raw TEXT
      );
      CREATE TABLE IF NOT EXISTS binding (
        id INTEGER PRIMARY KEY CHECK (id = 1), chain_id INTEGER NOT NULL, operator TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operation_history (
        operator TEXT NOT NULL, hash TEXT NOT NULL, nonce INTEGER NOT NULL, raw TEXT NOT NULL,
        PRIMARY KEY(operator,hash), UNIQUE(operator,nonce)
      );
      CREATE TRIGGER IF NOT EXISTS preserve_operation_update BEFORE UPDATE ON operation_history
        BEGIN SELECT RAISE(ABORT, 'Operation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_operation_delete BEFORE DELETE ON operation_history
        BEGIN SELECT RAISE(ABORT, 'Operation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_operation_replace BEFORE INSERT ON operation_history
        WHEN EXISTS(SELECT 1 FROM operation_history WHERE operator=NEW.operator AND (hash=NEW.hash OR nonce=NEW.nonce))
        BEGIN SELECT RAISE(ABORT, 'Operation history is append-only'); END;
      CREATE TABLE IF NOT EXISTS cancellation_history (
        operator TEXT NOT NULL, original_hash TEXT NOT NULL, nonce INTEGER NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL,
        PRIMARY KEY (operator,hash)
      );
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_update BEFORE UPDATE ON cancellation_history
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_delete BEFORE DELETE ON cancellation_history
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_cancellation_replace BEFORE INSERT ON cancellation_history
        WHEN EXISTS(SELECT 1 FROM cancellation_history WHERE operator=NEW.operator AND hash=NEW.hash)
        BEGIN SELECT RAISE(ABORT, 'Cancellation history is append-only'); END;
      CREATE TABLE IF NOT EXISTS protected_bundles (
        operator TEXT NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, valid_until_ms INTEGER, PRIMARY KEY(operator,hash)
      );
      CREATE TABLE IF NOT EXISTS bundle_acknowledgments (
        operator TEXT NOT NULL, hash TEXT NOT NULL, bundle_hash TEXT NOT NULL, PRIMARY KEY(operator,hash,bundle_hash)
      );
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_update BEFORE UPDATE ON protected_bundles
        BEGIN SELECT RAISE(ABORT, 'Protected bundle history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_delete BEFORE DELETE ON protected_bundles
        BEGIN SELECT RAISE(ABORT, 'Protected bundle history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_replace BEFORE INSERT ON protected_bundles
        WHEN EXISTS(SELECT 1 FROM protected_bundles WHERE operator=NEW.operator AND hash=NEW.hash)
        BEGIN SELECT RAISE(ABORT, 'Protected bundle history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_ack_update BEFORE UPDATE ON bundle_acknowledgments
        BEGIN SELECT RAISE(ABORT, 'Builder acknowledgment history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_ack_delete BEFORE DELETE ON bundle_acknowledgments
        BEGIN SELECT RAISE(ABORT, 'Builder acknowledgment history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_bundle_ack_replace BEFORE INSERT ON bundle_acknowledgments
        WHEN EXISTS(SELECT 1 FROM bundle_acknowledgments WHERE operator=NEW.operator AND hash=NEW.hash AND bundle_hash=NEW.bundle_hash)
        BEGIN SELECT RAISE(ABORT, 'Builder acknowledgment history is append-only'); END;`)
      const binding = this.journal.prepare('SELECT chain_id, operator FROM binding WHERE id = 1').get() as
        { chain_id: number; operator: string } | undefined
      if (binding) {
        if (binding.chain_id !== chainId || binding.operator !== this.operator)
          throw new Error('The protected journal belongs to another chain or operator.')
      } else if (chainId !== 1 && (this.journal.prepare(`SELECT 1 FROM pending UNION ALL SELECT 1 FROM cancellation_history
        UNION ALL SELECT 1 FROM operation_history UNION ALL SELECT 1 FROM protected_bundles UNION ALL SELECT 1 FROM bundle_acknowledgments LIMIT 1`).get() ||
        this.journal.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
          AND name NOT IN ('pending','binding','operation_history','cancellation_history','protected_bundles','bundle_acknowledgments')
          AND name NOT LIKE 'sqlite_%' LIMIT 1`).get())) {
        throw new Error('Only verified Ethereum journals can be migrated without a chain binding.')
      }
      const pending = this.journal.prepare('SELECT operator, hash, nonce, raw, cancel_hash, cancel_raw FROM pending').all() as
        (Pending & { operator: string })[]
      for (const item of pending) {
        const tx = this.validate(item.raw, false)
        if (item.operator !== this.operator || tx.hash !== item.hash || tx.nonce !== item.nonce ||
          (item.cancel_hash == null) !== (item.cancel_raw == null))
          throw new Error('The protected journal cannot be verified for this operator.')
        this.retainOperation(tx, item.raw)
        if (item.cancel_raw != null) {
          const cancellation = this.validate(item.cancel_raw, true)
          if (cancellation.hash !== item.cancel_hash || cancellation.nonce !== item.nonce)
            throw new Error('The protected cancellation record is inconsistent.')
          this.retainCancellation(item.hash, cancellation, item.cancel_raw)
        }
      }
      for (const item of this.journal.prepare('SELECT * FROM operation_history').iterate()) {
        const tx = this.validate(String(item.raw), false)
        if (item.operator !== this.operator || tx.hash !== item.hash || tx.nonce !== item.nonce)
          throw new Error('The retained protected operation record is inconsistent.')
      }
      for (const item of this.journal.prepare('SELECT * FROM cancellation_history').iterate()) {
        const tx = this.validate(String(item.raw), true)
        const original = this.journal.prepare('SELECT hash FROM operation_history WHERE operator=? AND nonce=?')
          .get(this.operator, tx.nonce)
        if (item.operator !== this.operator || tx.hash !== item.hash || tx.nonce !== item.nonce ||
          typeof item.original_hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(item.original_hash) ||
          (original && original.hash !== item.original_hash) ||
          pending.some((original) => original.nonce === item.nonce && original.hash !== item.original_hash))
          throw new Error('The retained protected cancellation record is inconsistent.')
      }
      for (const item of this.journal.prepare('SELECT * FROM protected_bundles').iterate()) {
        if (chainId !== 56 || item.operator !== this.operator || typeof item.body !== 'string')
          throw new Error('The protected bundle journal has an inconsistent binding.')
        const { raw, maxTimestamp } = readBnbBundle(item.body)
        let cancellation: boolean
        try { const tx = Transaction.from(raw); cancellation = tx.data === '0x' && tx.value === 0n } catch { throw new Error('Invalid journaled bundle transaction.') }
        if (this.validate(raw, cancellation).hash !== item.hash)
          throw new Error('The protected bundle journal has an inconsistent transaction.')
        if (cancellation ? item.valid_until_ms !== null : typeof item.valid_until_ms !== 'number' ||
          !Number.isSafeInteger(item.valid_until_ms) || maxTimestamp > Math.floor(item.valid_until_ms / 1000))
          throw new Error('The protected bundle journal has an inconsistent fee expiration.')
      }
      for (const item of this.journal.prepare('SELECT * FROM bundle_acknowledgments').iterate()) {
        if (item.operator !== this.operator || typeof item.bundle_hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(item.bundle_hash) ||
          !this.journal.prepare('SELECT 1 FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, item.hash))
          throw new Error('The protected builder acknowledgment is inconsistent.')
      }
      if (!binding) this.journal.prepare('INSERT INTO binding (id, chain_id, operator) VALUES (1, ?, ?)').run(chainId, this.operator)
      this.journal.exec('COMMIT')
    } catch (error) {
      try { this.journal.exec('ROLLBACK') } catch { /* Initialization may have failed before BEGIN. */ }
      this.journal.close()
      super.destroy()
      throw error
    }
  }

  override async _send(payload: JsonRpcPayload | JsonRpcPayload[]): Promise<JsonRpcResult[]> {
    const calls = Array.isArray(payload) ? payload : [payload]
    if (calls.length === 1 && calls[0].method === 'eth_sendRawTransaction') {
      const { params, id } = calls[0]
      if (!Array.isArray(params) || params.length !== 1 || typeof params[0] !== 'string')
        throw new Error('A single signed Railgun transaction is required.')
      return [{ id, result: await this.sendProtected(params[0]) }]
    }
    if (calls.some((call) => !READ_METHODS.has(call.method)))
      throw new Error('This provider permits reads and protected raw submissions only.')
    return super._send(payload)
  }

  override async broadcastTransaction(raw: string, validUntilMs?: number) {
    if (this.chainId === 56 && validUntilMs !== undefined) {
      const tx = this.validate(raw, false)
      if (this.executionGuard && tx.type === 4 && tx.to !== this.executionGuard)
        throw new Error('This operator requires guarded private execution.')
      await this.journalSigned(raw, tx, false, undefined, validUntilMs)
    }
    return super.broadcastTransaction(raw)
  }

  pendingTransaction(): PendingSummary | undefined {
    const pending = this.pending()
    return pending && { hash: pending.hash, nonce: pending.nonce,
      ...(pending.cancel_hash ? { cancellationHash: pending.cancel_hash } : {}) }
  }

  /** Retry only the identical journaled payload; never sign a replacement after a timeout. */
  async retryPending(): Promise<string> {
    const pending = this.pending()
    if (!pending) throw new Error('There is no journaled transaction to retry.')
    return this.sendProtected(pending.cancel_raw ?? pending.raw, !!pending.cancel_raw, pending.cancel_hash ?? pending.hash)
  }

  /** Operator-signed, zero-value self-transfer; invalidates only the journaled gas nonce. */
  async cancelPending(signedCancellation: string): Promise<string> {
    return this.sendProtected(signedCancellation, true)
  }

  /** Persist an already signed operation without publishing it, including restart recovery. */
  async stageSigned(raw: string): Promise<string> {
    return this.journalSigned(raw, this.validate(raw, false), false)
  }

  /** Local recovery only: preserve the newer pointer before selecting a journaled lower nonce after a reorg. */
  async stageRecovery(raw: string, expectedPending: PendingSummary): Promise<string> {
    return this.journalSigned(raw, this.validate(raw, false), false, undefined, undefined, expectedPending)
  }

  override destroy(): void {
    if (this.destroyed) return
    this.journal.close()
    super.destroy()
  }

  private pending(): Pending | undefined {
    return this.journal.prepare('SELECT hash, nonce, raw, cancel_hash, cancel_raw FROM pending WHERE operator = ?')
      .get(this.operator) as Pending | undefined
  }

  private retainOperation(tx: Transaction, raw: string): void {
    if (this.journal.prepare('SELECT 1 FROM cancellation_history WHERE operator=? AND nonce=? AND original_hash<>?')
      .get(this.operator, tx.nonce, tx.hash!))
      throw new Error('The retained cancellation belongs to another operation at this nonce.')
    const previous = this.journal.prepare('SELECT hash,nonce,raw FROM operation_history WHERE operator=? AND (hash=? OR nonce=?)')
      .get(this.operator, tx.hash!, tx.nonce)
    if (previous) {
      if (previous.hash !== tx.hash || previous.nonce !== tx.nonce || String(previous.raw).toLowerCase() !== raw.toLowerCase())
        throw new Error('Another signed operation already owns this protected nonce.')
    } else this.journal.prepare('INSERT INTO operation_history(operator,hash,nonce,raw) VALUES(?,?,?,?)')
      .run(this.operator, tx.hash!, tx.nonce, raw)
  }

  private retainCancellation(originalHash: string, tx: Transaction, raw: string): void {
    const previous = this.journal.prepare('SELECT original_hash,nonce,raw FROM cancellation_history WHERE operator=? AND hash=?')
      .get(this.operator, tx.hash!)
    if (previous) {
      if (previous.original_hash !== originalHash || previous.nonce !== tx.nonce || String(previous.raw).toLowerCase() !== raw.toLowerCase())
        throw new Error('The retained protected cancellation record is inconsistent.')
    } else this.journal.prepare('INSERT INTO cancellation_history(operator,original_hash,nonce,hash,raw) VALUES(?,?,?,?,?)')
      .run(this.operator, originalHash, tx.nonce, tx.hash!, raw)
  }

  private validate(raw: string, cancellation: boolean): Transaction {
    // Never include the signed payload in an error or upstream diagnostic.
    let tx: Transaction
    try { tx = Transaction.from(raw) } catch { throw new Error('Invalid signed transaction.') }
    if (tx.serialized !== raw.toLowerCase()) throw new Error('Canonical transaction encoding is required.')
    // The caller reserves and signs the exact native refund in the same operator nonce journal.
    const nativeRefund = this.nativeRefunds && !cancellation && tx.type === 2 && tx.value > 0n && tx.data === '0x' &&
      !!tx.to && !/^0x0{40}$/i.test(tx.to) && tx.to !== this.operator && !tx.authorizationList?.length
    if (!tx.isSigned() || !tx.hash || tx.from !== this.operator || tx.chainId !== BigInt(this.chainId) || (tx.value !== 0n && !nativeRefund) ||
      !tx.to || tx.gasLimit <= 0n || tx.gasLimit > 30_000_000n)
      throw new Error('Only this operator’s signed Railgun transactions on the selected chain are accepted.')
    if (cancellation) {
      if (tx.type !== 2 || tx.to !== this.operator || tx.data !== '0x' || tx.gasLimit < 21_000n ||
        (this.chainId === 1 && tx.gasLimit !== 21_000n) || tx.authorizationList?.length)
        throw new Error('Cancellation must be a signed type-2, zero-value self-transfer within the selected chain gas bounds.')
    } else if (nativeRefund) {
      if (tx.gasLimit < 21_000n) throw new Error('Native refund gas limit is below the transaction minimum.')
    } else if (tx.data === '0x') {
      throw new Error('Railgun calldata is required.')
    } else if (tx.type === 4) {
      const account = tx.to === this.executionGuard ? decodeGuardedExecution(tx.data).account : tx.to
      const auth = tx.authorizationList?.[0]
      if (account === this.operator || tx.authorizationList?.length !== 1 || !auth || auth.chainId !== BigInt(this.chainId) ||
        getAddress(auth.address) !== getAddress(this.config.relayAdapt7702Contract) ||
        getAddress(verifyAuthorization(auth, auth.signature)) !== getAddress(account))
        throw new Error('The canonical, chain-bound Railgun authorization is required.')
    } else if (![0, 1, 2].includes(tx.type ?? -1) || tx.authorizationList?.length ||
      getAddress(tx.to) !== getAddress(this.config.proxyContract)) {
      throw new Error('Unsupported Railgun transaction target or type.')
    }
    if (tx.type === 2 || tx.type === 4) {
      if (!tx.maxFeePerGas || !tx.maxPriorityFeePerGas || tx.maxPriorityFeePerGas > tx.maxFeePerGas)
        throw new Error('Protected submission requires a positive priority fee within the signed fee cap.')
    } else if (!tx.gasPrice) throw new Error('A positive signed gas price is required.')
    return tx
  }

  private async checkFork(): Promise<void> {
    for (const method of ['anvil_metadata', 'hardhat_metadata']) {
      const result = await this.read(method, [], true)
      if (result) throw new Error('Protected mainnet broadcasting is disabled on local forks.')
    }
  }

  private async read(method: string, params: unknown[], allowUnsupported = false): Promise<unknown> {
    // Bypass the queue for guard reads made while _send is servicing a broadcast.
    try {
      const [result] = await super._send({ jsonrpc: '2.0', id: 1, method, params }) as (JsonRpcResult | JsonRpcError)[]
      if (result?.id === 1 && 'error' in result && allowUnsupported && result.error.code === -32601) return undefined
      if (!result || result.id !== 1 || 'error' in result) throw new Error()
      return result.result
    } catch { throw new Error('The trusted read node could not verify submission state.') }
  }

  private async quantity(method: string, params: unknown[]): Promise<bigint> {
    const result = await this.read(method, params)
    if (typeof result !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(result))
      throw new Error('The trusted read node returned an invalid quantity.')
    return BigInt(result)
  }

  private async bnbHead(height: bigint): Promise<{ number: number; timestamp: number }> {
    const tag = `0x${height.toString(16)}`
    const block = await this.read('eth_getBlockByNumber', [tag, false]) as { number?: unknown; timestamp?: unknown; hash?: unknown } | null
    if (typeof block?.number !== 'string' || block.number.toLowerCase() !== tag ||
      typeof block.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(block.hash) || /^0x0{64}$/i.test(block.hash) ||
      typeof block.timestamp !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block.timestamp))
      throw new Error('The trusted BNB head identity or timestamp is invalid.')
    return { number: Number(height), timestamp: Number(BigInt(block.timestamp)) }
  }

  private async journalSigned(raw: string, tx: Transaction, cancellation: boolean, retryHash?: string, validUntilMs?: number,
    recovery?: PendingSummary): Promise<string> {
    const hash = tx.hash!
    this.forkCheck ??= this.checkFork().catch((error) => { this.forkCheck = undefined; throw error })
    await this.forkCheck
    const chain = await this.read('eth_chainId', [])
    if (chain !== `0x${this.chainId.toString(16)}`) throw new Error('A read node for the selected mainnet chain is required.')
    if (this.executionGuard && tx.to === this.executionGuard && !cancellation && tx.type === 4) {
      const [code, delegateCode] = await Promise.all([
        this.read('eth_getCode', [this.executionGuard, 'latest']),
        this.read('eth_getCode', [this.config.relayAdapt7702Contract, 'latest']),
      ])
      if (typeof code !== 'string' || typeof delegateCode !== 'string') throw new Error('Execution guard code is unavailable.')
      assertExecutionGuardCode(this.operator, code, delegateCode, this.config.relayAdapt7702Contract)
    }
    const height = await this.quantity('eth_blockNumber', [])
    const bnbHead = this.chainId === 56 ? await this.bnbHead(height) : undefined
    // Read confirmed state, not a public pending pool that cannot see private submissions.
    const [latest, confirmed] = await Promise.all([
      this.quantity('eth_getTransactionCount', [this.operator, 'latest']),
      this.quantity('eth_getTransactionCount', [this.operator,
        this.chainId === 1 ? `0x${(height > 0n ? height - 1n : 0n).toString(16)}` : 'finalized']),
    ])
    if (confirmed > latest) throw new Error('The trusted read node returned inconsistent nonce state.')
    this.journal.exec('BEGIN IMMEDIATE')
    try {
      const pending = this.pending()
      const retained = pending?.hash === hash || !!this.journal.prepare(`SELECT 1 FROM cancellation_history WHERE operator=? AND hash=?
        UNION ALL SELECT 1 FROM operation_history WHERE operator=? AND hash=? LIMIT 1`).get(this.operator, hash, this.operator, hash)
      if (retryHash && (pending?.cancel_hash ?? pending?.hash) !== retryHash)
        throw new Error('The pending transaction changed while retrying. Read the current journal before retrying.')
      if (cancellation && (!pending || pending.nonce !== tx.nonce))
        throw new Error('Cancellation must use the existing journaled operator nonce.')
      if (recovery) {
        if (cancellation || !pending || pending.hash !== recovery.hash || pending.nonce !== recovery.nonce ||
          (pending.cancel_hash ?? undefined) !== recovery.cancellationHash || pending.nonce <= tx.nonce ||
          latest !== confirmed || latest !== BigInt(tx.nonce))
          throw new Error('The reorg recovery pointer or confirmed nonce changed; preserve both journals.')
        this.retainOperation(this.validate(pending.raw, false), pending.raw)
        this.journal.prepare('DELETE FROM pending WHERE operator=?').run(this.operator)
      } else if (pending && confirmed > BigInt(pending.nonce)) {
        this.journal.prepare('DELETE FROM pending WHERE operator = ?').run(this.operator)
      } else if (!cancellation && pending && (pending.hash !== hash || pending.cancel_hash)) {
        throw new Error('Operator nonce is unresolved. Reconcile or retry the identical journaled transaction.')
      }
      if (latest !== BigInt(tx.nonce)) throw new Error('The signed operator nonce must match mined state.')
      if (cancellation) {
        if (pending!.cancel_hash !== hash && this.journal.prepare('SELECT 1 FROM cancellation_history WHERE operator=? AND hash=?').get(this.operator, hash))
          throw new Error('An earlier cancellation cannot replace the latest retry target.')
        this.retainCancellation(pending!.hash, tx, raw)
        this.journal.prepare('UPDATE pending SET cancel_hash = ?, cancel_raw = ? WHERE operator = ?')
          .run(hash, raw, this.operator)
      } else {
        this.retainOperation(tx, raw)
        const cancellation = this.journal.prepare(`SELECT hash,raw FROM cancellation_history
          WHERE operator=? AND original_hash=? ORDER BY rowid DESC LIMIT 1`).get(this.operator, hash)
        this.journal.prepare('INSERT OR IGNORE INTO pending (operator, hash, nonce, raw) VALUES (?, ?, ?, ?)')
          .run(this.operator, hash, tx.nonce, raw)
        if (cancellation) this.journal.prepare('UPDATE pending SET cancel_hash=?,cancel_raw=? WHERE operator=?')
          .run(cancellation.hash, cancellation.raw, this.operator)
      }
      // Existing raw-only BNB records stay held: adding a fresh wrapper would silently renew an unknown publication.
      if (bnbHead && !retained && (cancellation || validUntilMs !== undefined) &&
        !this.journal.prepare('SELECT 1 FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, hash))
        this.journal.prepare('INSERT INTO protected_bundles(operator,hash,body,valid_until_ms) VALUES(?,?,?,?)')
          .run(this.operator, hash, createBnbBundle(raw, bnbHead, cancellation ? undefined : validUntilMs), cancellation ? null : validUntilMs!)
      this.journal.exec('COMMIT')
    } catch (error) {
      try { this.journal.exec('ROLLBACK') } catch { /* COMMIT may have already rolled back. */ }
      throw error
    }
    return hash
  }

  private async sendProtected(raw: string, cancellation = false, retryHash?: string): Promise<string> {
    protectedWriteRPC(this.chainId)
    const tx = this.validate(raw, cancellation)
    if (this.executionGuard && !cancellation && tx.type === 4 && tx.to !== this.executionGuard)
      throw new Error('This operator requires guarded private execution.')
    if (this.chainId === 56 && !cancellation &&
      !this.journal.prepare('SELECT 1 FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, tx.hash!))
      throw new Error('This BNB transaction has no journaled bundle with authenticated fee expiration. No raw submission was staged; reconcile any existing held record.')
    const hash = await this.journalSigned(raw, tx, cancellation, retryHash)
    let body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
    if (this.chainId === 56) {
      const stored = this.journal.prepare('SELECT body FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, hash)
      if (typeof stored?.body !== 'string')
        throw new Error('This BNB transaction has no journaled bundle with authenticated fee expiration. Its signed bytes and nonce remain held; reconcile or explicitly cancel.')
      body = stored.body
      assertBnbBundleUnexpired(body, raw, await this.quantity('eth_blockNumber', []))
    }
    const bundleHash = await submitProtected(this.chainId, body, hash)
    if (bundleHash) {
      try {
        this.journal.prepare(`INSERT INTO bundle_acknowledgments(operator,hash,bundle_hash) SELECT ?,?,?
          WHERE NOT EXISTS(SELECT 1 FROM bundle_acknowledgments WHERE operator=? AND hash=? AND bundle_hash=?)`)
          .run(this.operator, hash, bundleHash, this.operator, hash, bundleHash)
      } catch {
        throw new Error('Protected submission outcome is unknown; its signed transaction and envelope remain journaled. The builder acknowledgment could not be retained. No public fallback was attempted.')
      }
    }
    return hash
  }
}
