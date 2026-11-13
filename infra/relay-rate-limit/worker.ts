// Pages binds this namespace from the separate Worker; no public endpoint or secret is needed here.
export class RelayRateLimiter {
  private readonly state: DurableObjectState
  constructor(state: DurableObjectState) { this.state = state }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const success = await this.state.storage.transaction(async (storage) => {
      const now = Date.now()
      const recent = (await storage.get<number[]>('requests') ?? []).filter((time) => time > now - 60_000)
      if (recent.length >= 40) return false
      await storage.put('requests', [...recent, now])
      await storage.setAlarm(now + 60_000)
      return true
    })
    return Response.json({ success })
  }

  async alarm(): Promise<void> {
    const requests = await this.state.storage.get<number[]>('requests') ?? []
    const last = requests.at(-1) ?? 0
    if (last + 60_000 > Date.now()) await this.state.storage.setAlarm(last + 60_000)
    else await this.state.storage.deleteAll()
  }
}

export default { fetch: (): Response => new Response('Not found', { status: 404 }) }
