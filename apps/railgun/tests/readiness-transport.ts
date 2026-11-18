import { FetchResponse, type FetchRequest } from 'ethers'

export type ThrottleSample = { attempt: number; reason: string; retryInMs: number | null }

export function configureReadinessTransport(transport: FetchRequest, throttles: ThrottleSample[]): void {
  transport.timeout = 20_000
  transport.setThrottleParams({ maxAttempts: 1, slotInterval: 0 })
  transport.retryFunc = async () => false
  const getUrl = transport.getUrlFunc
  transport.getUrlFunc = async (request, signal) => {
    const deadline = Date.now() + request.timeout
    for (let attempt = 0; ; attempt++) {
      const next = request.clone()
      next.timeout = Math.max(1, deadline - Date.now())
      const result = await getUrl(next, signal)
      if (result.statusCode !== 429) return result
      const response = new FetchResponse(result.statusCode, result.statusMessage, result.headers, result.body, request)
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
      const retry = attempt < 3 && wait <= 8000 && Date.now() + wait < deadline && reason !== 'shared-provider-quota'
      throttles.push({ attempt: attempt + 1, reason, retryInMs: retry ? wait : null })
      if (!retry) return result
      // Own backoff here: ethers 6.14 retries immediately and interprets Retry-After seconds as milliseconds.
      await new Promise(resolve => setTimeout(resolve, wait))
      if (Date.now() >= deadline) return result
    }
  }
}
