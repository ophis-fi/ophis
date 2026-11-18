import type { FetchRequest } from 'ethers'

export type ThrottleSample = { attempt: number; reason: string; retryInMs: number | null }

export function configureReadinessTransport(transport: FetchRequest, throttles: ThrottleSample[]): void {
  transport.timeout = 20_000
  transport.setThrottleParams({ maxAttempts: 4, slotInterval: 0 })
  transport.retryFunc = async (_request, response, attempt) => {
    let reason = 'http-429'
    try {
      const message = response.bodyJson?.error
      if (message === 'RPC rate limit reached. Retry shortly.') reason = 'gateway-request-rate'
      else if (message === 'Simulation rate limit reached. Retry shortly.') reason = 'gateway-simulation-rate'
      else if (/^(Alchemy|Validation Cloud) shared request rate reached\.$/.test(message)) reason = 'shared-provider-rate'
      else if (/^(Alchemy|Validation Cloud) shared CU budget reached\.$/.test(message)) reason = 'shared-provider-quota'
    } catch { /* Upstream responses need not be JSON; never log their body or URL. */ }
    const header = response.headers['retry-after']
    const retryAfter = header === undefined ? 0 : /^\d+$/.test(header)
      ? Number(header) * 1000 : Math.max(0, Date.parse(header) - Date.now())
    const wait = Math.max(2000 * 2 ** attempt, Number.isNaN(retryAfter) ? 0 : retryAfter)
    const retry = attempt < 3 && wait <= 8000 && reason !== 'shared-provider-quota'
    throttles.push({ attempt: attempt + 1, reason, retryInMs: retry ? wait : null })
    if (!retry) return false
    // ethers 6.14's first randomized slot is always zero; explicitly wait before retrying.
    await new Promise(resolve => setTimeout(resolve, wait))
    return true
  }
}
