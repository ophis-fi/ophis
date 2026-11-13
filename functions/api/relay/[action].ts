interface RelayEnv {
  RELAY_API_KEY?: string
  OPHIS_RELAY_RATE_LIMITER?: DurableObjectNamespace
}
class RelayRateLimitError extends Error {}
const ORIGINS = new Set(['https://ophis.fi', 'https://swap.ophis.fi', 'https://explorer.ophis.fi'])
const CHAINS = new Set([1, 10, 56, 100, 130, 137, 4663, 5042, 8453, 9745, 42161, 43114, 57073, 59144])
// Mirrored fee recipient: tests pin this to the SDK and both frontend constants.
const FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8'
const address = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{40}$/i.test(v)
const identifier = (v: unknown): v is string => typeof v === 'string' && /^0x[\da-f]{64}$/i.test(v)
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Invalid Relay response')
  return v as Record<string, unknown>
}

function quoteBody(body: unknown): Record<string, unknown> {
  const q = object(body)
  if (![q.user, q.recipient, q.refundTo, q.originCurrency, q.destinationCurrency].every(address)) throw new Error('address')
  if (typeof q.originChainId !== 'number' || typeof q.destinationChainId !== 'number') throw new Error('chain')
  if (!CHAINS.has(q.originChainId) || !CHAINS.has(q.destinationChainId) || q.originChainId === q.destinationChainId) throw new Error('chain')
  if (typeof q.amount !== 'string' || !/^[1-9]\d{0,77}$/.test(q.amount) || BigInt(q.amount) >= 2n ** 256n) throw new Error('amount')
  if (!Number.isInteger(q.slippageBps) || Number(q.slippageBps) < 0 || Number(q.slippageBps) > 100) throw new Error('slippage')
  return {
    user: q.user, recipient: q.recipient, refundTo: q.refundTo,
    originChainId: Number(q.originChainId), destinationChainId: Number(q.destinationChainId),
    originCurrency: q.originCurrency, destinationCurrency: q.destinationCurrency, amount: q.amount,
    slippageTolerance: String(q.slippageBps), tradeType: 'EXACT_INPUT',
    explicitDeposit: true, disableOriginSwaps: true, usePermit: false, includeProtocolData: true,
    referrer: 'ophis', appFees: [{ recipient: FEE_RECIPIENT, fee: '3' }],
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Relay response')
  const chunks: Uint8Array[] = []
  const size = { bytes: 0 }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    size.bytes += value.byteLength
    if (size.bytes > 2_000_000) {
      await reader.cancel()
      throw new Error('Oversized Relay response')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size.bytes)
  chunks.reduce((offset, chunk) => { bytes.set(chunk, offset); return offset + chunk.byteLength }, 0)
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

// Coalesce chain discovery before admission so cache hits spend no App read quota.
const chainCache: { until: number; pending?: Promise<unknown> } = { until: 0 }
async function upstream(path: string, key: string, body?: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`https://api.relay.link${path}`, {
    method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(6_000),
    headers: { 'x-api-key': key, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new Error('Relay unavailable')
  return boundedJson(response)
}
function getChains(key: string, namespace: DurableObjectNamespace): Promise<unknown> {
  if (chainCache.pending && Date.now() < chainCache.until) return chainCache.pending
  chainCache.until = Date.now() + 300_000
  chainCache.pending = admitted(namespace, 'relay:app:reads').then(() => upstream('/chains', key)).catch((error: unknown) => {
    chainCache.pending = undefined
    throw error
  })
  return chainCache.pending
}

async function admitted(namespace: DurableObjectNamespace, key: string): Promise<void> {
  const path = key === 'relay:app:reads' ? '/reads' : '/'
  const response = await namespace.get(namespace.idFromName(key)).fetch(`https://relay-limits.internal${path}`, { method: 'POST' })
  if (!response.ok) throw new Error('Relay admission unavailable')
  const result = object(await response.json())
  if (result.success !== true) throw new RelayRateLimitError()
}

function allowedOrigin(origin: string | null, url: URL): boolean {
  if (!origin || ORIGINS.has(origin) || origin === url.origin) return true
  try { return ['localhost', '127.0.0.1'].includes(url.hostname) && new URL(origin).hostname === url.hostname } catch { return false }
}

export const onRequest: PagesFunction<RelayEnv> = async ({ request, env, params }) => {
  const origin = request.headers.get('origin')
  const url = new URL(request.url)
  const allowed = allowedOrigin(origin, url)
  const headers = {
    'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'access-control-allow-origin': allowed && origin ? origin : 'https://swap.ophis.fi',
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'Origin',
  }
  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers })
  if (!allowed) return json({ error: 'Forbidden' }, 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  const action = params.action
  if (!['chains', 'quote', 'status'].includes(String(action))) return json({ error: 'Not found' }, 404)
  if (request.method !== (action === 'quote' ? 'POST' : 'GET')) return json({ error: 'Method not allowed' }, 405)
  if (!env.RELAY_API_KEY || !env.OPHIS_RELAY_RATE_LIMITER) return json({ error: 'Relay is not enabled' }, 503)
  try {
    const limiter = env.OPHIS_RELAY_RATE_LIMITER
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'
    await admitted(limiter, `relay:${action}:${ip}`)
    if (action === 'chains') return json(await getChains(env.RELAY_API_KEY, limiter))
    if (action === 'status') {
      const requestId = url.searchParams.get('requestId')
      if (!identifier(requestId)) return json({ error: 'Invalid request id' }, 400)
      await admitted(limiter, 'relay:app:reads')
      const status = object(await upstream(`/intents/status/v3?requestId=${requestId}`, env.RELAY_API_KEY))
      return json({ status: status.status, inTxHashes: status.inTxHashes, txHashes: status.txHashes, refundFailReason: status.refundFailReason })
    }
    const body = await request.text()
    if (body.length > 4096) return json({ error: 'Body too large' }, 413)
    const parsed = (() => { try { return quoteBody(JSON.parse(body) as unknown) } catch { return null } })()
    if (!parsed) return json({ error: 'Invalid bridge request' }, 400)
    await admitted(limiter, 'relay:app:quotes')
    const quote = object(await upstream('/quote/v2', env.RELAY_API_KEY, parsed))
    const details = object(quote.details)
    const impact = object(object(details.expandedPriceImpact).app)
    if (!Number.isFinite(Number(impact.usd)) || Number(impact.usd) === 0) throw new Error('App fee missing')
    return json({ requestId: quote.requestId, protocol: quote.protocol, details: { currencyOut: details.currencyOut, timeEstimate: details.timeEstimate } })
  } catch (error: unknown) {
    if (error instanceof RelayRateLimitError) return json({ error: 'Rate limited' }, 429)
    return json({ error: 'Relay is temporarily unavailable' }, 502)
  }
}
