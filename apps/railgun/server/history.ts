import { BASE_HISTORY as B, BASE_HISTORY_PATH, historyAssert, historyDigest, historyHash, historyJSON,
  historyQuantity, validateHistoryLogs, validateHistoryManifest, type HistoryManifest, type HistoryPage, type HistoryTail } from '../base-history'
import { alchemyCU, isAlchemyUrl } from '../rpc-policy'

type Budget = (methods: string[], provider: 'alchemy') => { allowed: boolean; reason?: string }
interface Job { toBlock: number; blockHash: string; timestamp: number; pages: HistoryPage[]; previous?: HistoryManifest }
interface State { current?: HistoryManifest; previous?: HistoryManifest; job?: Job; scheduled?: boolean; nextAttempt: number; retryAt?: number }
const stateKey = 1, dailyLimit = 10_000, tailLifetime = 30_000
const tailDailyLimit = 350_000
const hex = (value: number) => `0x${value.toString(16)}`
class HistoryBudgetUnavailable extends Error {
  constructor(message: string, readonly retryAt: number) { super(message) }
}

/** Public Base logs only; shares the existing account meter and its SQLite storage. */
export class BaseHistoryCache {
  private working?: Promise<void>
  private tail?: { generation: string; at: number; pending: boolean; value: Promise<HistoryTail> }
  constructor(private storage: DurableObjectStorage, private env: Env, private consume: Budget) {
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS base_history_state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)')
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS base_history_parts(hash TEXT NOT NULL, part INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(hash,part))')
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS base_history_usage(day TEXT PRIMARY KEY, cu INTEGER NOT NULL)')
    this.storage.sql.exec('CREATE TABLE IF NOT EXISTS base_history_tail(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)')
  }
  private state(): State {
    const row = this.storage.sql.exec<{ body: string }>('SELECT body FROM base_history_state WHERE id=?', stateKey).toArray()[0]
    return row ? JSON.parse(row.body) as State : { nextAttempt: 0 }
  }
  private save(state: State): void {
    this.storage.sql.exec('INSERT INTO base_history_state(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', stateKey, JSON.stringify(state))
  }
  private endpoint(): string {
    const endpoint = this.env.RAILGUN_BASE_RPC_URL
    historyAssert(this.env.RAILGUN_RPC_ENABLED === 'true' && this.env.RAILGUN_BASE_ALCHEMY_EXTENDED === 'true' &&
      endpoint && isAlchemyUrl(B.chainId, endpoint), 'Base history provider is unavailable.')
    return endpoint
  }
  private async rpc(method: string, params: unknown[], historical: boolean): Promise<unknown> {
    const endpoint = this.endpoint(), day = new Date().toISOString().slice(0, 10), cost = alchemyCU(method)
    historyAssert(cost !== undefined, 'Unpriced public history method.')
    const usage = `${historical ? 'history' : 'tail'}:${day}`
    const used = Number(this.storage.sql.exec<{ cu: number }>('SELECT cu FROM base_history_usage WHERE day=?', usage).toArray()[0]?.cu ?? 0)
    if (used + cost > (historical ? dailyLimit : tailDailyLimit))
      throw new HistoryBudgetUnavailable('Base history daily budget reached.', Date.parse(`${day}T00:00:00Z`) + 86_400_000)
    const reserved = this.consume([method], 'alchemy')
    if (!reserved.allowed) throw new HistoryBudgetUnavailable('Shared RPC budget unavailable.', Date.now() + B.refreshMs)
    this.storage.sql.exec('DELETE FROM base_history_usage WHERE day NOT IN (?,?)', `history:${day}`, `tail:${day}`)
    this.storage.sql.exec('INSERT INTO base_history_usage(day,cu) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET cu=excluded.cu', usage, used + cost)
    // Charge attempts before network I/O; no redirect, retry or public fallback.
    const response = await fetch(endpoint, { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(method === 'eth_getLogs' ? 20_000 : 10_000),
      headers: { 'Content-Type': 'application/json', Origin: 'https://swap.ophis.fi', 'User-Agent': 'Ophis-Base-History/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    const { value } = await historyJSON(response, method === 'eth_getLogs' ? 8 * 1024 ** 2 : 512 * 1024)
    const result = value as { jsonrpc?: string; id?: unknown; error?: unknown; result?: unknown }
    historyAssert(result?.jsonrpc === '2.0' && result.id === 1 && !result.error && 'result' in result, 'Invalid public history RPC response.')
    return result.result
  }
  private async header(block: string, historical: boolean) {
    const value = await this.rpc('eth_getBlockByNumber', [block, false], historical) as Record<string, unknown>
    historyAssert(value && historyHash(value.hash), 'Invalid public history anchor.')
    const number = historyQuantity(value.number), timestamp = historyQuantity(value.timestamp)
    historyAssert(number >= B.fromBlock && timestamp > 0 && timestamp <= Date.now() / 1000 + 30, 'Invalid public history anchor.')
    if (block !== 'finalized' && block !== 'latest') historyAssert(number === historyQuantity(block), 'Public history anchor height differs.')
    return { number, hash: value.hash.toLowerCase(), timestamp }
  }
  async manifest(): Promise<HistoryManifest | undefined> {
    this.endpoint()
    const state = this.state()
    if (!state.job && Date.now() >= state.nextAttempt) {
      // Persist backoff before scheduling, including cold misses and restarts.
      state.nextAttempt = Date.now() + B.refreshMs
      state.scheduled = true
      this.save(state)
      await this.storage.setAlarm(Date.now() + 1)
    }
    return state.current
  }
  page(generation: string, index: number): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(generation) || !Number.isSafeInteger(index) || index < 0) return undefined
    const state = this.state(), manifest = [state.current, state.previous].find(value => value?.generation === generation)
    const page = manifest?.pages[index]
    if (!page) return undefined
    return this.body(page.hash)
  }
  private body(hash: string): string | undefined {
    const parts = this.storage.sql.exec<{ body: string; part: number }>('SELECT body,part FROM base_history_parts WHERE hash=? ORDER BY part', hash).toArray()
    if (!parts.length || parts.some((part, offset) => part.part !== offset)) return undefined
    return parts.map(part => part.body).join('')
  }
  private storeBody(hash: string, body: string): void {
    const stored = Number(this.storage.sql.exec<{ bytes: number }>('SELECT COALESCE(SUM(length(body)),0) AS bytes FROM base_history_parts').toArray()[0].bytes)
    historyAssert(stored + body.length <= B.maxBytes, 'Base history storage ceiling reached.')
    for (let offset = 0, part = 0; offset < body.length; offset += 128 * 1024, part++)
      this.storage.sql.exec('INSERT OR IGNORE INTO base_history_parts(hash,part,body) VALUES(?,?,?)', hash, part, body.slice(offset, offset + 128 * 1024))
  }
  async alarm(): Promise<void> {
    this.working ??= this.advance().finally(() => { this.working = undefined })
    return this.working
  }
  private async advance(): Promise<void> {
    let state = this.state()
    if (state.retryAt && Date.now() < state.retryAt) {
      await this.storage.setAlarm(state.retryAt)
      return
    }
    delete state.retryAt
    try {
      this.endpoint()
      if (!state.job) {
        if (!state.scheduled) return
        state.scheduled = false
        this.save(state)
        historyAssert(await this.rpc('eth_chainId', [], true) === '0x2105', 'Base history chain differs.')
        const target = await this.header('finalized', true)
        if (state.current) {
          const old = await this.header(hex(state.current.toBlock), true)
          historyAssert(old.hash === state.current.blockHash && target.number >= old.number, 'Finalized Base history changed.')
        }
        const pages = state.current?.pages.filter(page => page.toBlock - page.fromBlock + 1 === B.width && page.toBlock <= target.number) ?? []
        state.job = { toBlock: target.number, blockHash: target.hash, timestamp: target.timestamp, pages, previous: state.current }
        this.save(state)
      }
      const job = state.job
      // Two fixed pages per alarm keeps execution, responses and concurrency bounded.
      for (let count = 0; count < 2; count++) {
        const fromBlock = B.fromBlock + job.pages.length * B.width
        if (fromBlock > job.toBlock) break
        historyAssert(job.pages.length < B.maxPages, 'Base history page limit reached.')
        const toBlock = Math.min(job.toBlock, fromBlock + B.width - 1)
        const logs = validateHistoryLogs(await this.rpc('eth_getLogs', [{ address: B.address, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }], true), fromBlock, toBlock)
        const body = JSON.stringify(logs), bytes = new TextEncoder().encode(body).length
        historyAssert(bytes <= B.pageBytes, 'Base public history page is too large.')
        const page = { fromBlock, toBlock, hash: await historyDigest(body), bytes, count: logs.length }
        historyAssert(job.pages.reduce((sum, item) => sum + item.bytes, bytes) <= B.maxBytes / 2 &&
          job.pages.reduce((sum, item) => sum + item.count, logs.length) <= B.maxLogs, 'Base history cache limit reached.')
        this.storage.transactionSync(() => {
          this.storeBody(page.hash, body)
          job.pages.push(page); this.save(state)
        })
      }
      if (B.fromBlock + job.pages.length * B.width <= job.toBlock) {
        await this.storage.setAlarm(Date.now() + 2_000)
        return
      }
      const anchor = await this.header(hex(job.toBlock), true)
      historyAssert(anchor.hash === job.blockHash, 'Base history anchor changed during collection.')
      if (job.previous) historyAssert((await this.header(hex(job.previous.toBlock), true)).hash === job.previous.blockHash, 'Base history prefix changed.')
      const core = { version: 1 as const, chainId: B.chainId, address: B.address, fromBlock: B.fromBlock,
        toBlock: job.toBlock, blockHash: job.blockHash, timestamp: job.timestamp, pages: job.pages }
      const manifest = await validateHistoryManifest({ ...core, generation: await historyDigest(JSON.stringify(core)) })
      this.storage.transactionSync(() => {
        state = { current: manifest, previous: state.current, nextAttempt: Date.now() + B.refreshMs }
        this.save(state); this.prune(state)
      })
    } catch (error) {
      if (error instanceof HistoryBudgetUnavailable) {
        // A cold scan can span daily allowances; retain its verified prefix without publishing it.
        state.retryAt = state.nextAttempt = error.retryAt
        if (!state.job) state.scheduled = true
        this.save(state)
        await this.storage.setAlarm(error.retryAt)
        return
      }
      // Preserve the last complete generation; never publish an incomplete scan.
      state = { current: state.current, previous: state.previous, nextAttempt: Date.now() + B.refreshMs }
      this.storage.transactionSync(() => { this.save(state); this.prune(state) })
    }
  }
  private prune(state: State): void {
    const retained = new Set([...(state.current?.pages ?? []), ...(state.previous?.pages ?? []), ...(state.job?.pages ?? [])].map(page => page.hash))
    const tail = this.savedTail()
    if (tail?.hash) retained.add(tail.hash)
    for (const row of this.storage.sql.exec<{ hash: string }>('SELECT DISTINCT hash FROM base_history_parts').toArray())
      if (!retained.has(row.hash)) this.storage.sql.exec('DELETE FROM base_history_parts WHERE hash=?', row.hash)
  }
  private savedTail(): { generation: string; at: number; leaseUntil?: number; hash?: string } | undefined {
    const row = this.storage.sql.exec<{ body: string }>('SELECT body FROM base_history_tail WHERE id=1').toArray()[0]
    return row && JSON.parse(row.body)
  }
  async recent(generation: string): Promise<HistoryTail> {
    const state = this.state(), manifest = state.current
    historyAssert(manifest && manifest.generation === generation, 'Base history generation changed. Retry the current manifest.')
    if (this.tail?.generation === generation && (this.tail.pending || Date.now() - this.tail.at < tailLifetime)) return this.tail.value
    const saved = this.savedTail()
    if (saved && (Date.now() - saved.at < tailLifetime || !saved.hash && Date.now() < (saved.leaseUntil ?? 0))) {
      historyAssert(saved.generation === generation && saved.hash, 'Base recent history is warming. Retry shortly.')
      const body = this.body(saved.hash)
      historyAssert(body && await historyDigest(body) === saved.hash, 'Base recent history cache is incomplete.')
      return JSON.parse(body) as HistoryTail
    }
    const at = Date.now()
    const previousBody = saved?.generation === generation && saved.hash ? this.body(saved.hash) : undefined
    this.storage.sql.exec('INSERT INTO base_history_tail(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
      JSON.stringify({ generation, at, leaseUntil: at + 65_000 }))
    this.prune(state)
    const value = (async () => {
      const deadline = Date.now() + 60_000
      const head = await this.header('latest', false)
      historyAssert(head.number >= manifest.toBlock && head.number - manifest.toBlock <= B.maxTail, 'Base history needs a newer finalized snapshot.')
      const fromBlock = manifest.toBlock + 1
      let nextBlock = fromBlock, prefix: HistoryTail['logs'] = [], prefixVerified = false
      if (previousBody && saved?.hash && await historyDigest(previousBody) === saved.hash) {
        const previous = JSON.parse(previousBody) as HistoryTail
        historyAssert(previous.generation === generation && previous.fromBlock === fromBlock &&
          Number.isSafeInteger(previous.toBlock) && previous.toBlock >= manifest.toBlock && previous.toBlock <= head.number &&
          historyHash(previous.blockHash), 'Invalid previous Base history tail.')
        if ((await this.header(hex(previous.toBlock), false)).hash === previous.blockHash) {
          // Canonical ancestry preserves the already verified prefix, including empty spans.
          prefix = validateHistoryLogs(previous.logs, fromBlock, previous.toBlock)
          nextBlock = previous.toBlock + 1; prefixVerified = true
        }
      }
      const suffix = head.number < nextBlock ? [] : validateHistoryLogs(await this.rpc('eth_getLogs', [
        { address: B.address, fromBlock: hex(nextBlock), toBlock: hex(head.number) },
      ], false), nextBlock, head.number)
      // Roots alone do not authenticate nullifiers/unshields. Check every represented
      // block against the canonical chain, once per block and within the shared cap.
      const blocks = new Map(suffix.map(log => [historyQuantity(log.blockNumber), log.blockHash]))
      historyAssert(blocks.size <= 128, 'Base recent history has too many event blocks. Wait for a finalized snapshot.')
      for (const [number, hash] of blocks) {
        historyAssert(Date.now() < deadline - 10_000, 'Base recent history verification timed out.')
        historyAssert((await this.header(hex(number), false)).hash === hash, 'Base recent event belongs to an orphaned block.')
      }
      historyAssert(Date.now() < deadline - 20_000, 'Base recent history verification timed out.')
      historyAssert((prefixVerified || (await this.header(hex(manifest.toBlock), false)).hash === manifest.blockHash) &&
        (await this.header(hex(head.number), false)).hash === head.hash, 'Base recent history changed during collection.')
      const logs = validateHistoryLogs([...prefix, ...suffix], fromBlock, head.number)
      const tail = { generation, fromBlock, toBlock: head.number, blockHash: head.hash, timestamp: head.timestamp, logs }
      const body = JSON.stringify(tail)
      historyAssert(new TextEncoder().encode(body).length <= 8 * 1024 ** 2, 'Base recent history is too large.')
      const hash = await historyDigest(body)
      this.storage.transactionSync(() => {
        this.storeBody(hash, body)
        this.storage.sql.exec('INSERT INTO base_history_tail(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body', JSON.stringify({ generation, at: Date.now(), hash }))
      })
      return tail
    })()
    this.tail = { generation, at, pending: true, value }
    void value.then(() => { if (this.tail?.value === value) { this.tail.pending = false; this.tail.at = Date.now() } },
      () => { if (this.tail?.value === value) this.tail.pending = false })
    return value
  }
}

export async function baseHistoryResponse(request: Request, env: Env): Promise<Response> {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  const reply = (body: unknown, status: number) => Response.json(body, { status, headers })
  const url = new URL(request.url)
  if (request.method !== 'GET') return reply({ error: 'GET required.' }, 405)
  if (url.search || request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return reply({ error: 'Invalid public history request.' }, 403)
  if (env.RAILGUN_RPC_ENABLED !== 'true' || env.RAILGUN_BASE_ALCHEMY_EXTENDED !== 'true' || !env.RAILGUN_BASE_RPC_URL ||
    !isAlchemyUrl(B.chainId, env.RAILGUN_BASE_RPC_URL) || !env.VALIDATION_CLOUD_BUDGET) return reply({ error: 'Base history is unavailable.' }, 503)
  if (!(await env.RPC_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) return reply({ error: 'History rate limit reached.' }, 429)
  const stub = env.VALIDATION_CLOUD_BUDGET.getByName('alchemy-shared-account')
  try {
    if (url.pathname === `${BASE_HISTORY_PATH}/manifest`) {
      const manifest = await stub.baseHistoryManifest()
      return reply(manifest ?? { status: 'warming' }, manifest ? 200 : 202)
    }
    const page = new RegExp(`^${BASE_HISTORY_PATH}/page/([0-9a-f]{64})/(0|[1-9][0-9]{0,3})$`).exec(url.pathname)
    if (page) {
      const body = await stub.baseHistoryPage(page[1], Number(page[2]))
      return body === undefined ? reply({ error: 'Public history page not found.' }, 404)
        : new Response(body, { headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=31536000, immutable' } })
    }
    const tail = new RegExp(`^${BASE_HISTORY_PATH}/tail/([0-9a-f]{64})$`).exec(url.pathname)
    if (tail) return reply(await stub.baseHistoryTail(tail[1]), 200)
    return reply({ error: 'Public history route not found.' }, 404)
  } catch { return reply({ error: 'Base history is not ready. Retry without clearing your wallet.' }, 503) }
}
