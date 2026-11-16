import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { FetchRequest, getAddress, isError, JsonRpcProvider, Transaction, verifyAuthorization,
  type JsonRpcPayload, type JsonRpcResult, type JsonRpcError } from 'ethers'
import { assertExecutionGuardCode, decodeGuardedExecution } from './execution-guard'
import { assertBnbBundleUnexpired, createBnbBundle, protectedWriteRPC, readBnbBundle, submitProtected } from './protected-submission'
import { assertBaseValidityUnexpired, createBaseValidityBody, readBaseValidityBody, validateBaseValidityPlan, type BaseValidityPlan } from './base-validity'
export { PROTECTED_WRITE_RPC, protectedWriteRPC } from './protected-submission'

const NETWORKS: Record<number, NetworkName | undefined> = {
  1: NetworkName.Ethereum, 42161: NetworkName.Arbitrum, 56: NetworkName.BNBChain, 137: NetworkName.Polygon,
  8453: NetworkName.Base,
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
type Operation = Pick<Pending, 'hash' | 'nonce' | 'raw'>

/** Node-only transport for an operator's existing, validated Railgun transaction sender. */
export class ProtectedEthereumProvider extends JsonRpcProvider {
  private readonly journal: DatabaseSync
  private readonly operator: string
  private forkCheck?: Promise<void>
  private readonly executionGuard?: string
  private readonly config: (typeof NETWORK_CONFIG)[NetworkName]

  constructor(readRPC: string | FetchRequest, operatorAddress: string, privateStateDirectory: string, executionGuard?: string,
    private readonly chainId = 1, private readonly nativeRefunds = false, private readonly writeRPC?: string) {
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
      CREATE TABLE IF NOT EXISTS base_validity (
        operator TEXT NOT NULL, hash TEXT NOT NULL, plan TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(operator,hash)
      );
      CREATE TRIGGER IF NOT EXISTS preserve_base_validity_update BEFORE UPDATE ON base_validity
        BEGIN SELECT RAISE(ABORT, 'Base validity history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_base_validity_delete BEFORE DELETE ON base_validity
        BEGIN SELECT RAISE(ABORT, 'Base validity history is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS preserve_base_validity_replace BEFORE INSERT ON base_validity
        WHEN EXISTS(SELECT 1 FROM base_validity WHERE operator=NEW.operator AND hash=NEW.hash)
        BEGIN SELECT RAISE(ABORT, 'Base validity history is append-only'); END;
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
        UNION ALL SELECT 1 FROM operation_history UNION ALL SELECT 1 FROM protected_bundles UNION ALL SELECT 1 FROM bundle_acknowledgments
        UNION ALL SELECT 1 FROM base_validity LIMIT 1`).get() ||
        this.journal.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
          AND name NOT IN ('pending','binding','operation_history','cancellation_history','protected_bundles','bundle_acknowledgments','base_validity')
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
      for (const item of this.journal.prepare('SELECT * FROM base_validity').iterate()) {
        if (chainId !== 8453 || item.operator !== this.operator || typeof item.body !== 'string' || typeof item.plan !== 'string')
          throw new Error('The Base validity journal has an inconsistent binding.')
        const envelope = readBaseValidityBody(item.body), plan = validateBaseValidityPlan(JSON.parse(item.plan))
        const retained = this.journal.prepare(`SELECT raw FROM operation_history WHERE operator=? AND hash=?
          UNION ALL SELECT raw FROM cancellation_history WHERE operator=? AND hash=?`).get(this.operator, item.hash, this.operator, item.hash)
        if (envelope.hash !== item.hash || typeof retained?.raw !== 'string' || retained.raw.toLowerCase() !== envelope.raw.toLowerCase() ||
          createBaseValidityBody(envelope.raw, plan) !== item.body || JSON.stringify(plan) !== item.plan)
          throw new Error('The Base validity envelope differs from its retained transaction or fee plan.')
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

  override async broadcastTransaction(raw: string, validUntilMs?: number, basePlan?: BaseValidityPlan) {
    if (basePlan && this.chainId !== 8453) throw new Error('Base validity plans belong only to Base.')
    if (this.chainId === 8453 && basePlan) {
      const plan = validateBaseValidityPlan(basePlan)
      if (validUntilMs !== undefined && validUntilMs !== plan.feeExpiryMs)
        throw new Error('The Base validity plan differs from its authenticated fee expiration.')
      await this.journalSigned(raw, this.validate(raw, false), false, undefined, validUntilMs, undefined, plan)
    }
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
  async cancelPending(signedCancellation: string, basePlan?: BaseValidityPlan): Promise<string> {
    return this.sendProtected(signedCancellation, true, undefined, basePlan)
  }

  /** Persist an already signed operation without publishing it, including restart recovery. */
  async stageSigned(raw: string, basePlan?: BaseValidityPlan): Promise<string> {
    return this.journalSigned(raw, this.validate(raw, false), false, undefined, undefined, undefined, basePlan, true)
  }

  /** Local recovery only: preserve the newer pointer before selecting a journaled lower nonce after a reorg. */
  async stageRecovery(raw: string, expectedPending: PendingSummary, basePlan?: BaseValidityPlan): Promise<string> {
    return this.journalSigned(raw, this.validate(raw, false), false, undefined, undefined, expectedPending, basePlan, true)
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
    if (this.chainId === 8453 && (tx.type !== 2 || tx.authorizationList?.length))
      throw new Error('Base validity publication requires a type-2 transaction without an authorization list.')
    if (cancellation) {
      if (tx.type !== 2 || tx.to !== this.operator || tx.data !== '0x' || tx.gasLimit < 21_000n ||
        (this.chainId === 1 && tx.gasLimit !== 21_000n) || tx.authorizationList?.length)
        throw new Error('Cancellation must be a signed type-2, zero-value self-transfer within the selected chain gas bounds.')
    } else if (nativeRefund) {
      if (tx.gasLimit < 21_000n) throw new Error('Native refund gas limit is below the transaction minimum.')
    } else if (tx.data === '0x') {
      throw new Error('Railgun calldata is required.')
    } else if (this.chainId === 8453) {
      if (!this.executionGuard || tx.to !== this.executionGuard || decodeGuardedExecution(tx.data).account === this.operator)
        throw new Error('Base execution requires its reviewed guard and a separate predelegated account.')
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

  /** Verify the read route before readiness; recheck the chain on every submission. */
  async assertReadNetwork(): Promise<void> {
    this.forkCheck ??= this.checkFork().catch((error) => { this.forkCheck = undefined; throw error })
    await this.forkCheck
    const chain = await this.read('eth_chainId', [])
    if (chain !== `0x${this.chainId.toString(16)}`) throw new Error('A read node for the selected mainnet chain is required.')
  }

  private async checkFork(): Promise<void> {
    for (const method of ['anvil_metadata', 'hardhat_metadata']) {
      const result = await this.read(method, [], true)
      if (result) throw new Error('Protected mainnet broadcasting is disabled on local forks.')
    }
  }

  private unsupportedForkProbe(value: unknown, method: string): boolean {
    if (!['anvil_metadata', 'hardhat_metadata'].includes(method) || !value || typeof value !== 'object' || Array.isArray(value)) return false
    const reply = value as Record<string, unknown>
    if (reply.jsonrpc !== '2.0' || reply.id !== 1 || 'result' in reply || !reply.error ||
      typeof reply.error !== 'object' || Array.isArray(reply.error)) return false
    const error = reply.error as Record<string, unknown>
    // Alchemy reports unsupported fork probes as HTTP400/-32600 rather than -32601.
    // Only exact method-bound refusals qualify; authentication and invalid-request errors do not.
    return error.code === -32600 && (error.message === `Unsupported method: ${method}` ||
      error.message === `Unsupported method: ${method}.` ||
      (this.chainId === 42161 && error.message === `Unsupported method: ${method} on ARB_MAINNET`))
  }

  private async read(method: string, params: unknown[], allowUnsupported = false): Promise<unknown> {
    // Bypass the queue for guard reads made while _send is servicing a broadcast.
    try {
      const [result] = await super._send({ jsonrpc: '2.0', id: 1, method, params }) as (JsonRpcResult | JsonRpcError)[]
      if (result?.id === 1 && 'jsonrpc' in result && result.jsonrpc === '2.0' && !('result' in result) &&
        'error' in result && allowUnsupported && result.error.code === -32601) return undefined
      if (!result || result.id !== 1 || 'error' in result) throw new Error()
      return result.result
    } catch (error) {
      if (allowUnsupported && isError(error, 'SERVER_ERROR') && error.response?.statusCode === 400 &&
        error.response.body && error.response.body.length <= 4096) {
        try { if (this.unsupportedForkProbe(error.response.bodyJson, method)) return undefined }
        catch { /* Malformed error bodies never establish unsupported fork probes. */ }
      }
      throw new Error('The trusted read node could not verify submission state.')
    }
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

  private pipelineJournal(first: bigint) {
    return {
      pending: this.pending(),
      operations: this.journal.prepare('SELECT hash,nonce,raw FROM operation_history WHERE operator=? AND nonce>=? ORDER BY nonce LIMIT 21')
        .all(this.operator, first) as Operation[],
      cancellations: this.journal.prepare('SELECT original_hash,hash,nonce,raw FROM cancellation_history WHERE operator=? AND nonce>=? ORDER BY nonce,rowid')
        .all(this.operator, first) as (Operation & { original_hash: string })[],
    }
  }

  private async nativeNonceState(tx: Transaction) {
    const network = this.chainId === 42161 ? 'Arbitrum' : 'Base'
    const block = async (tag: string) => {
      const value = await this.read('eth_getBlockByNumber', [tag, false]) as { number?: string; hash?: string; timestamp?: string } | null
      if (!value || typeof value.number !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.number) ||
        BigInt(value.number) > BigInt(Number.MAX_SAFE_INTEGER) || (tag.startsWith('0x') && BigInt(value.number) !== BigInt(tag)) ||
        typeof value.hash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(value.hash) || /^0x0{64}$/i.test(value.hash) ||
        typeof value.timestamp !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value.timestamp))
        throw new Error(`The canonical ${network} block identity is unavailable.`)
      return { number: value.number, hash: value.hash, timestamp: Number(BigInt(value.timestamp)) }
    }
    const [head, finalized] = await Promise.all([block('latest'), block('finalized')])
    if (BigInt(finalized.number) > BigInt(head.number) || Math.abs(Date.now() / 1000 - head.timestamp) > 45)
      throw new Error(`The canonical ${network} head is stale or inconsistent.`)
    const [latest, confirmed] = await Promise.all([
      this.quantity('eth_getTransactionCount', [this.operator, head.number]),
      this.quantity('eth_getTransactionCount', [this.operator, finalized.number]),
    ])
    if (confirmed > latest || latest > BigInt(Number.MAX_SAFE_INTEGER) || latest - confirmed > 20n || latest !== BigInt(tx.nonce))
      throw new Error(`The ${network} nonce range is inconsistent or exceeds 20 outstanding operations.`)
    const journal = this.pipelineJournal(confirmed)
    if (journal.operations.length > 20 || journal.operations.some((operation, index) => BigInt(operation.nonce) !== confirmed + BigInt(index)) ||
      (journal.operations.length === 20 && !journal.operations.some(operation => operation.nonce === tx.nonce)))
      throw new Error(`The complete ${network} nonce journal must fit within 20 outstanding operations.`)
    const canonical = new Map<string, Promise<Awaited<ReturnType<typeof block>>>>()
    for (let nonce = confirmed; nonce < latest; nonce++) {
      const operation = journal.operations.find(item => BigInt(item.nonce) === nonce)
      if (!operation) throw new Error(`A consumed ${network} nonce is missing from the protected journal.`)
      const candidates = [operation, ...journal.cancellations.filter(item => item.nonce === operation.nonce)]
      let included = false
      for (const candidate of candidates) {
        const signed = this.validate(candidate.raw, candidate !== operation)
        if (signed.hash !== candidate.hash || signed.nonce !== operation.nonce ||
          ('original_hash' in candidate && candidate.original_hash !== operation.hash))
          throw new Error(`The retained ${network} transaction identity is inconsistent.`)
        const receipt = await this.read('eth_getTransactionReceipt', [candidate.hash]) as {
          transactionHash?: string; blockNumber?: string; blockHash?: string; status?: string
        } | null
        if (!receipt) continue
        if (receipt.transactionHash !== candidate.hash || typeof receipt.blockNumber !== 'string' ||
          !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(receipt.blockNumber) ||
          BigInt(receipt.blockNumber) <= BigInt(finalized.number) || BigInt(receipt.blockNumber) > BigInt(head.number) ||
          typeof receipt.blockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(receipt.blockHash) ||
          (receipt.status !== '0x0' && receipt.status !== '0x1'))
          throw new Error(`The ${network} inclusion receipt does not match its journaled transaction.`)
        if (!canonical.has(receipt.blockNumber)) canonical.set(receipt.blockNumber, block(receipt.blockNumber))
        if ((await canonical.get(receipt.blockNumber)!).hash === receipt.blockHash) {
          if (included) throw new Error(`Multiple journaled transactions consumed the same ${network} nonce.`)
          included = true
        }
      }
      if (!included) throw new Error(`A consumed ${network} nonce has no canonical journaled inclusion.`)
    }
    const [currentHead, currentFinalized] = await Promise.all([block(head.number), block(finalized.number)])
    if (currentHead.hash !== head.hash || currentFinalized.hash !== finalized.hash || Math.abs(Date.now() / 1000 - head.timestamp) > 45)
      throw new Error(`${network} canonical history changed while checking the nonce journal.`)
    return { latest, confirmed, journal: JSON.stringify(journal), blockNumber: head.number, blockHash: head.hash }
  }

  private async assertBaseAuthority(tx: Transaction, cancellation: boolean, head: { blockNumber: string; blockHash: string }): Promise<void> {
    const calls = [this.read('eth_getCode', [this.operator, head.blockNumber])]
    if (!cancellation && tx.value === 0n) {
      const { account } = decodeGuardedExecution(tx.data)
      calls.push(this.read('eth_getCode', [this.executionGuard!, head.blockNumber]),
        this.read('eth_getCode', [this.config.relayAdapt7702Contract, head.blockNumber]),
        this.read('eth_getCode', [account, head.blockNumber]))
    }
    const [operatorCode, guardCode, delegateCode, accountCode] = await Promise.all(calls)
    if (operatorCode !== '0x') throw new Error('Base prepaid gas must use an undelegated operator.')
    if (!cancellation && tx.value === 0n) {
      if (typeof guardCode !== 'string' || typeof delegateCode !== 'string' || typeof accountCode !== 'string' ||
        accountCode.toLowerCase() !== `0xef0100${this.config.relayAdapt7702Contract.slice(2).toLowerCase()}`)
        throw new Error('The Base execution account must already delegate to the canonical Railgun implementation.')
      assertExecutionGuardCode(this.operator, guardCode, delegateCode, this.config.relayAdapt7702Contract)
    }
    const canonical = await this.read('eth_getBlockByNumber', [head.blockNumber, false]) as { hash?: string } | null
    if (canonical?.hash !== head.blockHash) throw new Error('Base authority changed canonical history before staging.')
  }

  private async journalSigned(raw: string, tx: Transaction, cancellation: boolean, retryHash?: string, validUntilMs?: number,
    recovery?: PendingSummary, basePlan?: BaseValidityPlan, stagingOnly = false): Promise<string> {
    const hash = tx.hash!
    if (basePlan && this.chainId !== 8453) throw new Error('Base validity plans belong only to Base.')
    const plan = basePlan && validateBaseValidityPlan(basePlan), baseBody = plan && createBaseValidityBody(raw, plan)
    await this.assertReadNetwork()
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
    const pipeline = [42161, 8453].includes(this.chainId) && this.nativeRefunds ? await this.nativeNonceState(tx) : undefined
    if (this.chainId === 8453) {
      if (!pipeline) throw new Error('Base validity submission requires native prepaid mode.')
      // Recovery must retain an original even if its account revoked delegation before the signing crash was reconciled.
      // Every publication, including retry and cancellation, checks authority again against the pinned canonical head.
      if (!stagingOnly) await this.assertBaseAuthority(tx, cancellation, pipeline)
    }
    // Read confirmed state, not a public pending pool that cannot see private submissions.
    const [latest, confirmed] = pipeline ? [pipeline.latest, pipeline.confirmed] : await Promise.all([
      this.quantity('eth_getTransactionCount', [this.operator, 'latest']),
      this.quantity('eth_getTransactionCount', [this.operator,
        this.chainId === 1 ? `0x${(height > 0n ? height - 1n : 0n).toString(16)}` : 'finalized']),
    ])
    if (confirmed > latest) throw new Error('The trusted read node returned inconsistent nonce state.')
    this.journal.exec('BEGIN IMMEDIATE')
    try {
      if (pipeline && JSON.stringify(this.pipelineJournal(confirmed)) !== pipeline.journal)
        throw new Error('The protected native journal changed during canonical verification; retry its current state.')
      const pending = this.pending()
      const retained = pending?.hash === hash || !!this.journal.prepare(`SELECT 1 FROM cancellation_history WHERE operator=? AND hash=?
        UNION ALL SELECT 1 FROM operation_history WHERE operator=? AND hash=? LIMIT 1`).get(this.operator, hash, this.operator, hash)
      if (baseBody) {
        const saved = this.journal.prepare('SELECT plan,body FROM base_validity WHERE operator=? AND hash=?').get(this.operator, hash)
        if (saved ? saved.body !== baseBody || saved.plan !== JSON.stringify(plan) : retained)
          throw new Error('A retained Base transaction cannot change or acquire a new validity envelope; preserve its held nonce.')
        if (!saved) this.journal.prepare('INSERT INTO base_validity(operator,hash,plan,body) VALUES(?,?,?,?)')
          .run(this.operator, hash, JSON.stringify(plan), baseBody)
      }
      if (retryHash && (pending?.cancel_hash ?? pending?.hash) !== retryHash)
        throw new Error('The pending transaction changed while retrying. Read the current journal before retrying.')
      if (cancellation && (!pending || pending.nonce !== tx.nonce))
        throw new Error('Cancellation must use the existing journaled operator nonce.')
      if (recovery) {
        if (cancellation || !pending || pending.hash !== recovery.hash || pending.nonce !== recovery.nonce ||
          (pending.cancel_hash ?? undefined) !== recovery.cancellationHash || pending.nonce <= tx.nonce ||
          (!pipeline && latest !== confirmed) || latest !== BigInt(tx.nonce))
          throw new Error('The reorg recovery pointer or confirmed nonce changed; preserve both journals.')
        this.retainOperation(this.validate(pending.raw, false), pending.raw)
        this.journal.prepare('DELETE FROM pending WHERE operator=?').run(this.operator)
      } else if (pending && (pipeline ? latest : confirmed) > BigInt(pending.nonce)) {
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

  private async sendProtected(raw: string, cancellation = false, retryHash?: string, basePlan?: BaseValidityPlan): Promise<string> {
    protectedWriteRPC(this.chainId, this.writeRPC)
    const tx = this.validate(raw, cancellation)
    if (this.executionGuard && !cancellation && tx.type === 4 && tx.to !== this.executionGuard)
      throw new Error('This operator requires guarded private execution.')
    if (this.chainId === 56 && !cancellation &&
      !this.journal.prepare('SELECT 1 FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, tx.hash!))
      throw new Error('This BNB transaction has no journaled bundle with authenticated fee expiration. No raw submission was staged; reconcile any existing held record.')
    if (this.chainId === 8453 && !basePlan &&
      !this.journal.prepare('SELECT 1 FROM base_validity WHERE operator=? AND hash=?').get(this.operator, tx.hash!))
      throw new Error('This Base transaction has no saved fee-bound validity envelope. Preserve its held nonce or explicitly cancel.')
    const hash = await this.journalSigned(raw, tx, cancellation, retryHash, undefined, undefined, basePlan)
    let body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
    if (this.chainId === 56) {
      const stored = this.journal.prepare('SELECT body FROM protected_bundles WHERE operator=? AND hash=?').get(this.operator, hash)
      if (typeof stored?.body !== 'string')
        throw new Error('This BNB transaction has no journaled bundle with authenticated fee expiration. Its signed bytes and nonce remain held; reconcile or explicitly cancel.')
      body = stored.body
      assertBnbBundleUnexpired(body, raw, await this.quantity('eth_blockNumber', []))
    }
    if (this.chainId === 8453) {
      const saved = this.journal.prepare('SELECT plan,body FROM base_validity WHERE operator=? AND hash=?').get(this.operator, hash)
      if (typeof saved?.body !== 'string' || typeof saved.plan !== 'string') throw new Error('The held Base validity envelope is unavailable.')
      const plan = validateBaseValidityPlan(JSON.parse(saved.plan))
      body = saved.body
      if (createBaseValidityBody(readBaseValidityBody(body, raw).raw, plan) !== body)
        throw new Error('The retained Base validity predicates changed.')
      const height = await this.quantity('eth_blockNumber', [])
      if (Date.now() >= plan.feeExpiryMs) throw new Error('The Base fee quote expired; its signed nonce remains held. Cancel or reconcile it.')
      assertBaseValidityUnexpired(body, raw, height)
    }
    const bundleHash = await submitProtected(this.chainId, body, hash, this.writeRPC)
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
