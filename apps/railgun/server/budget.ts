import { DurableObject } from 'cloudflare:workers'
import { RPC_BATCH_SIZE, alchemyCU, alchemyThroughputCU, validationCloudCU } from '../rpc-policy'

// One meter for all three keys: reserve 10m of the account's 50m for other usage.
const CU_LIMIT = 40_000_000

// Deployment-only probe: a fixed zero/10-CU read, never an upstream transaction.
export async function probeBudget(request: Request, env: Env): Promise<Response> {
  const reply = (body: unknown, status: number) => Response.json(body, { status, headers: {
    'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  } })
  if (request.method !== 'POST') return reply({ error: 'POST required.' }, 405)
  const url = new URL(request.url)
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
    return reply({ error: 'Same-origin requests only.' }, 403)
  const authorization = request.headers.get('Authorization')
  if (!env.RAILGUN_RPC_TOKEN || !authorization) return reply({ error: 'Forbidden.' }, 403)
  const encoded = new TextEncoder()
  const [expected, presented] = await Promise.all(
    [`Bearer ${env.RAILGUN_RPC_TOKEN}`, authorization].map((value) => crypto.subtle.digest('SHA-256', encoded.encode(value))),
  )
  if (!crypto.subtle.timingSafeEqual(expected, presented)) return reply({ error: 'Forbidden.' }, 403)
  if (!(await env.RPC_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success)
    return reply({ error: 'RPC rate limit reached.' }, 429)
  const provider = url.pathname === '/rpc/budget/alchemy' ? 'alchemy'
    : url.pathname === '/rpc/budget/validationCloud' ? 'validationCloud' : undefined
  if (!provider) return reply({ error: 'Budget provider not supported.' }, 404)
  let stage = 'lookup'
  try {
    if (!env.VALIDATION_CLOUD_BUDGET) throw new Error('Budget binding is missing.')
    const stub = env.VALIDATION_CLOUD_BUDGET.getByName(provider === 'alchemy' ? 'alchemy-shared-account' : 'shared-account')
    stage = 'consume'
    const result = provider === 'alchemy' ? await stub.consume(['eth_chainId'], provider) : await stub.consume(['eth_chainId'])
    return reply(result, result.allowed ? 200 : 429)
  } catch (cause) {
    const error = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {}
    const scrub = (value: unknown): string => {
      let text = typeof value === 'string' ? value : 'Unknown'
      for (const [key, secret] of Object.entries(env)) {
        if (/(?:TOKEN|KEY|URL)$/.test(key) && typeof secret === 'string' && secret) {
          text = text.replaceAll(secret, '[redacted]')
          if (key.endsWith('URL')) {
            try {
              const url = new URL(secret)
              for (const credential of [...url.pathname.split('/'), ...url.searchParams.values(), url.username, url.password])
                if (credential) text = text.replaceAll(credential, '[redacted]')
            } catch { /* The full configured value was already removed. */ }
          }
        }
      }
      return text.replace(/https?:\/\/\S+|Bearer\s+\S+|[A-Za-z0-9_+\/=-]{24,}/gi, '[redacted]').slice(0, 500)
    }
    return reply({ error: 'RPC budget guard unavailable.', diagnostic: {
      stage, name: scrub(error.name), message: scrub(error.message),
      remote: error.remote === true, retryable: error.retryable === true, overloaded: error.overloaded === true,
    } }, 503)
  }
}

export class ValidationCloudBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, cu INTEGER NOT NULL)')
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pace (id INTEGER PRIMARY KEY, second REAL, calls REAL)')
  }

  consume(methods: string[], provider: 'validationCloud' | 'alchemy' = 'validationCloud'): { allowed: boolean; reason?: string; remainingCU?: number } {
    if (!Array.isArray(methods) || !methods.length || methods.length > RPC_BATCH_SIZE || methods.some((method) => typeof method !== 'string'))
      throw new Error('Invalid RPC budget request.')
    if (provider !== 'validationCloud' && provider !== 'alchemy') throw new Error('Invalid budget provider.')
    const alchemy = provider === 'alchemy'
    const now = Date.now()
    const month = new Date(now).toISOString().slice(0, alchemy ? 10 : 7)
    // A 32-day window covers any monthly reset date; leave 6m CU for other account usage.
    const oldest = alchemy ? new Date(now - 31 * 86_400_000).toISOString().slice(0, 10) : month
    const limit = alchemy ? 24_000_000 : CU_LIMIT
    const name = alchemy ? 'Alchemy' : 'Validation Cloud'
    const second = now / 1000
    const cost = methods.reduce((sum, method) => {
      const cu = alchemy ? alchemyCU(method) : validationCloudCU(method)
      if (cu === undefined) throw new Error('RPC method has no verified CU cost.')
      return sum + cu
    }, 0)
    const weight = alchemy ? methods.reduce((sum, method) => sum + alchemyThroughputCU(method)!, 0) : methods.length
    const refill = alchemy ? 100 : 60
    const burst = alchemy ? 1_200 : 60
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql
      if (!sql.exec('SELECT id FROM pace WHERE id = 1').toArray().length) {
        sql.exec('INSERT INTO pace(id, second, calls) VALUES(1, ?, 0)', second)
      }
      sql.exec('DELETE FROM usage WHERE month < ?', oldest)
      const used = Number(sql.exec<{ total: number }>('SELECT COALESCE(SUM(cu), 0) AS total FROM usage').one().total)
      if (used + cost > limit) return { allowed: false, reason: `${name} shared CU budget reached.`, remainingCU: Math.max(0, limit - used) }
      const pace = sql.exec<{ second: number; calls: number }>('SELECT second, calls FROM pace WHERE id = 1').one()
      const calls = Math.max(0, pace.calls - Math.max(0, second - pace.second) * refill)
      // Alchemy stays below even the documented 300 CU/s rolling 10-second allowance.
      if (calls + weight > burst) return { allowed: false, reason: `${name} shared request rate reached.` }
      sql.exec('INSERT INTO usage(month, cu) VALUES(?, ?) ON CONFLICT(month) DO UPDATE SET cu = cu + excluded.cu', month, cost)
      sql.exec('UPDATE pace SET second = ?, calls = ? WHERE id = 1', second, calls + weight)
      return { allowed: true, remainingCU: limit - used - cost }
    })
  }
}
