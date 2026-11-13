import { RELAY_API_URL } from './relay.constants'
import { RelayChain } from './relay.types'

export class RelayApi {
  private chains?: { until: number; value: Promise<RelayChain[]> }

  constructor(private readonly url = RELAY_API_URL) {}

  async request(action: string, body?: object): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), action === 'chains' ? 3_000 : 8_000)
    try {
      const response = await fetch(`${this.url}/${action}`, {
        method: body ? 'POST' : 'GET',
        credentials: 'omit',
        signal: controller.signal,
        ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
      })
      if (!response.ok) throw new Error('Relay bridge is unavailable')
      return (await response.json()) as unknown
    } finally {
      clearTimeout(timer)
    }
  }

  getChains(): Promise<RelayChain[]> {
    if (this.chains && Date.now() < this.chains.until) return this.chains.value
    const value = this.request('chains')
      .then((data) => {
        const chains = (data as { chains?: RelayChain[] }).chains
        if (!Array.isArray(chains)) throw new Error('Invalid Relay chains')
        return chains.filter((chain) => Number.isSafeInteger(chain.id) && !chain.disabled && chain.depositEnabled)
      })
      .catch((error: unknown) => {
        this.chains = undefined
        throw error
      })
    this.chains = { until: Date.now() + 300_000, value }
    return value
  }
}
