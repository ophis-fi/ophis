import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { FetchRequest, getAddress, JsonRpcProvider, Transaction, verifyAuthorization,
  type JsonRpcPayload, type JsonRpcResult, type JsonRpcError } from 'ethers'
import { assertExecutionGuardCode, decodeGuardedExecution } from './execution-guard'

// No fast mode or calldata/log hints, and no public write endpoint.
export const PROTECTED_WRITE_RPC = 'https://rpc.flashbots.net?hint=hash'
const NETWORKS: Record<number, NetworkName | undefined> = {
  1: NetworkName.Ethereum, 42161: NetworkName.Arbitrum, 56: NetworkName.BNBChain, 137: NetworkName.Polygon,
}

export function protectedWriteRPC(chainId = 1): string {
  if (chainId === 1) return PROTECTED_WRITE_RPC
  // The operator's separate live-acceptance gate must pass before BNB signing is armed.
  if (chainId === 56) return 'https://rpc.48.club'
  throw new Error('This chain has no qualified protected submission policy; publication remains disabled.')
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

/** Node-only transport for an operator's existing, validated Railgun transaction sender. */
export class ProtectedEthereumProvider extends JsonRpcProvider {
  private readonly journal: DatabaseSync
  private readonly operator: string
  private forkCheck?: Promise<void>
  private readonly executionGuard?: string
  private readonly config: (typeof NETWORK_CONFIG)[NetworkName]

  constructor(readRPC: string | FetchRequest, operatorAddress: string, privateStateDirectory: string, executionGuard?: string,
    private readonly chainId = 1) {
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
    let legacy = false
    try {
      const stat = fstatSync(file)
      if (!stat.isFile() || stat.uid !== directory.uid || (stat.mode & 0o077))
        throw new Error('The operator journal must be a private file (0600).')
      legacy = stat.size > 0
    } finally { closeSync(file) }
    this.journal = new DatabaseSync(path)
    try {
      this.journal.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS pending (
        operator TEXT PRIMARY KEY, hash TEXT NOT NULL, nonce INTEGER NOT NULL, raw TEXT NOT NULL,
        cancel_hash TEXT, cancel_raw TEXT
      );
    `)
      this.journal.exec('BEGIN IMMEDIATE')
      this.journal.exec(`CREATE TABLE IF NOT EXISTS binding (
        id INTEGER PRIMARY KEY CHECK (id = 1), chain_id INTEGER NOT NULL, operator TEXT NOT NULL
      )`)
      const binding = this.journal.prepare('SELECT chain_id, operator FROM binding WHERE id = 1').get() as
        { chain_id: number; operator: string } | undefined
      if (binding) {
        if (binding.chain_id !== chainId || binding.operator !== this.operator)
          throw new Error('The protected journal belongs to another chain or operator.')
      } else {
        if (legacy && chainId !== 1) throw new Error('Only verified Ethereum journals can be migrated without a chain binding.')
        const pending = this.journal.prepare('SELECT operator, hash, nonce, raw, cancel_hash, cancel_raw FROM pending').all() as
          (Pending & { operator: string })[]
        for (const item of pending) {
          const tx = this.validate(item.raw, false)
          if (item.operator !== this.operator || tx.hash !== item.hash || tx.nonce !== item.nonce ||
            !!item.cancel_hash !== !!item.cancel_raw)
            throw new Error('The legacy protected journal cannot be verified for this operator.')
          if (item.cancel_raw) {
            const cancellation = this.validate(item.cancel_raw, true)
            if (cancellation.hash !== item.cancel_hash || cancellation.nonce !== item.nonce)
              throw new Error('The legacy protected cancellation record is inconsistent.')
          }
        }
        this.journal.prepare('INSERT INTO binding (id, chain_id, operator) VALUES (1, ?, ?)').run(chainId, this.operator)
      }
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

  pendingTransaction(): { hash: string; nonce: number; cancellationHash?: string } | undefined {
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

  override destroy(): void {
    if (this.destroyed) return
    this.journal.close()
    super.destroy()
  }

  private pending(): Pending | undefined {
    return this.journal.prepare('SELECT hash, nonce, raw, cancel_hash, cancel_raw FROM pending WHERE operator = ?')
      .get(this.operator) as Pending | undefined
  }

  private validate(raw: string, cancellation: boolean): Transaction {
    // Never include the signed payload in an error or upstream diagnostic.
    let tx: Transaction
    try { tx = Transaction.from(raw) } catch { throw new Error('Invalid signed transaction.') }
    if (tx.serialized !== raw.toLowerCase()) throw new Error('Canonical transaction encoding is required.')
    if (!tx.isSigned() || !tx.hash || tx.from !== this.operator || tx.chainId !== BigInt(this.chainId) || tx.value !== 0n ||
      !tx.to || tx.gasLimit <= 0n || tx.gasLimit > 30_000_000n)
      throw new Error('Only this operator’s signed Railgun transactions on the selected chain are accepted.')
    if (cancellation) {
      if (tx.type !== 2 || tx.to !== this.operator || tx.data !== '0x' || tx.gasLimit < 21_000n ||
        (this.chainId === 1 && tx.gasLimit !== 21_000n) || tx.authorizationList?.length)
        throw new Error('Cancellation must be a signed type-2, zero-value self-transfer within the selected chain gas bounds.')
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

  private async journalSigned(raw: string, tx: Transaction, cancellation: boolean, retryHash?: string): Promise<string> {
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
      if (retryHash && (pending?.cancel_hash ?? pending?.hash) !== retryHash)
        throw new Error('The pending transaction changed while retrying. Read the current journal before retrying.')
      if (cancellation && (!pending || pending.nonce !== tx.nonce))
        throw new Error('Cancellation must use the existing journaled operator nonce.')
      if (pending && confirmed > BigInt(pending.nonce)) {
        this.journal.prepare('DELETE FROM pending WHERE operator = ?').run(this.operator)
      } else if (!cancellation && pending && (pending.hash !== hash || pending.cancel_hash)) {
        throw new Error('Operator nonce is unresolved. Reconcile or retry the identical journaled transaction.')
      }
      if (latest !== BigInt(tx.nonce)) throw new Error('The signed operator nonce must match mined state.')
      if (cancellation) {
        this.journal.prepare('UPDATE pending SET cancel_hash = ?, cancel_raw = ? WHERE operator = ?')
          .run(hash, raw, this.operator)
      } else {
        this.journal.prepare('INSERT OR IGNORE INTO pending (operator, hash, nonce, raw) VALUES (?, ?, ?, ?)')
          .run(this.operator, hash, tx.nonce, raw)
      }
      this.journal.exec('COMMIT')
    } catch (error) {
      try { this.journal.exec('ROLLBACK') } catch { /* COMMIT may have already rolled back. */ }
      throw error
    }
    return hash
  }

  private async sendProtected(raw: string, cancellation = false, retryHash?: string): Promise<string> {
    const endpoint = protectedWriteRPC(this.chainId)
    const tx = this.validate(raw, cancellation)
    if (this.executionGuard && !cancellation && tx.type === 4 && tx.to !== this.executionGuard)
      throw new Error('This operator requires guarded private execution.')
    const hash = await this.journalSigned(raw, tx, cancellation, retryHash)
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error('Protected endpoint rejected submission.')
      const result = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
      if (result.jsonrpc !== '2.0' || result.id !== 1 || result.error || result.result !== hash)
        throw new Error('Protected endpoint did not acknowledge the expected hash.')
      return hash
    } catch {
      // Even a rejection or timeout may follow acceptance: keep the nonce locked durably.
      throw new Error('Protected submission was not acknowledged. Its outcome is unknown; the signed transaction remains journaled. No public fallback was attempted.')
    }
  }
}
