import { DurableObject } from 'cloudflare:workers'
import { RPC_BATCH_SIZE, validationCloudCU } from '../rpc-policy'

// One meter for all three keys: reserve 10m of the account's 50m for other usage.
const CU_LIMIT = 40_000_000
export class ValidationCloudBudget extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS usage (month TEXT PRIMARY KEY, cu INTEGER NOT NULL)')
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS pace (id INTEGER PRIMARY KEY, second REAL, calls REAL)')
  }

  consume(methods: string[]): { allowed: boolean; reason?: string; remainingCU?: number } {
    if (!Array.isArray(methods) || !methods.length || methods.length > RPC_BATCH_SIZE || methods.some((method) => typeof method !== 'string'))
      throw new Error('Invalid RPC budget request.')
    const now = Date.now()
    const month = new Date(now).toISOString().slice(0, 7)
    const second = now / 1000
    const cost = methods.reduce((sum, method) => {
      const cu = validationCloudCU(method)
      if (cu === undefined) throw new Error('RPC method has no verified CU cost.')
      return sum + cu
    }, 0)
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql
      if (!sql.exec('SELECT id FROM pace WHERE id = 1').toArray().length) {
        sql.exec('INSERT INTO pace(id, second, calls) VALUES(1, ?, 0)', second)
      }
      sql.exec('DELETE FROM usage WHERE month <> ?', month)
      const used = Number(sql.exec<{ total: number }>('SELECT COALESCE(SUM(cu), 0) AS total FROM usage').one().total)
      if (used + cost > CU_LIMIT) return { allowed: false, reason: 'Validation Cloud shared CU budget reached.', remainingCU: Math.max(0, CU_LIMIT - used) }
      const pace = sql.exec<{ second: number; calls: number }>('SELECT second, calls FROM pace WHERE id = 1').one()
      const calls = Math.max(0, pace.calls - Math.max(0, second - pace.second) * 60)
      // Leave half the team's 120 requests/s allowance for other consumers.
      if (calls + methods.length > 60) return { allowed: false, reason: 'Validation Cloud shared request rate reached.' }
      sql.exec('INSERT INTO usage(month, cu) VALUES(?, ?) ON CONFLICT(month) DO UPDATE SET cu = cu + excluded.cu', month, cost)
      sql.exec('UPDATE pace SET second = ?, calls = ? WHERE id = 1', second, calls + methods.length)
      return { allowed: true, remainingCU: CU_LIMIT - used - cost }
    })
  }
}
