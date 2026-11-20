import {
  ACROSS_V5_DESTINATIONS, ACROSS_V5_ORIGINS, acrossAddress, acrossOrderId,
  acrossV5Request, parseAcrossV5Quote, parseAcrossV5Status,
} from '../../_shared/acrossV5'

interface Env {
  ACROSS_API_KEY?: string
  ACROSS_APP_FEE_BPS?: string
  OPHIS_RELAY_RATE_LIMITER?: DurableObjectNamespace
}

const ORIGINS = new Set(['https://ophis.fi', 'https://swap.ophis.fi', 'https://explorer.ophis.fi'])
const OPERATIONS = [{ kind: 'approve_token', ecosystem: 'evm' }, { kind: 'send_transaction', ecosystem: 'evm' }]

function capabilities(query: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams({
    include: 'tokens', limit: '100', reachableOnly: 'true',
    'capabilities.operations': 'approve_token:evm,send_transaction:evm',
  })
  query.forEach((value, key) => {
    if (result.has(key)) throw new Error('Unexpected query parameter')
    if (key === 'originChainId' && ACROSS_V5_ORIGINS.includes(Number(value)) && /^\d+$/.test(value)) result.set(key, value)
    else if (key === 'destinationChainId' && ACROSS_V5_DESTINATIONS.includes(Number(value)) && /^\d+$/.test(value)) result.set(key, value)
    else if (['originToken', 'destinationToken'].includes(key) && acrossAddress(value)) result.set(key, value)
    else if (['originCursor', 'destinationCursor'].includes(key) && /^[\w=+/\-]{1,256}$/.test(value)) result.set(key, value)
    else throw new Error('Unexpected query parameter')
  })
  if (!result.has('originChainId') && !result.has('destinationChainId')) throw new Error('Missing chain')
  return result
}

async function admitted(namespace: DurableObjectNamespace, bucket: string, reads: boolean): Promise<boolean> {
  const url = reads ? 'https://across-limits.internal/reads' : 'https://across-limits.internal/'
  const response = await namespace.get(namespace.idFromName(bucket)).fetch(url, { method: 'POST' })
  return response.ok && (await response.json<{ success: boolean }>()).success === true
}

export const onRequest: PagesFunction<Env> = async ({ request, env, params }) => {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  const allowed = !origin || origin === url.origin || ORIGINS.has(origin)
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', vary: 'Origin',
    ...(origin && allowed ? { 'access-control-allow-origin': origin } : {}),
    'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type',
  }
  const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers })
  if (!allowed) return json({ error: 'Forbidden' }, 403)
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  const action = params.action
  if (action !== 'quote' && action !== 'capabilities' && action !== 'status') return json({ error: 'Not found' }, 404)
  const quote = action === 'quote'
  if (request.method !== (quote ? 'POST' : 'GET')) return json({ error: 'Method not allowed' }, 405)
  if (!env.ACROSS_API_KEY || !env.OPHIS_RELAY_RATE_LIMITER) return json({ error: 'Across is unavailable' }, 503)

  const fee = Number(env.ACROSS_APP_FEE_BPS || 0)
  if (!Number.isSafeInteger(fee) || fee < 0 || fee > 10_000) return json({ error: 'Across is unavailable' }, 503)

  let path: string
  let bridge: ReturnType<typeof acrossV5Request> | undefined
  const orderId = url.searchParams.get('orderId')
  try {
    if (quote) {
      const body = await request.text()
      if (body.length > 1024 || url.search) return json({ error: 'Invalid quote request' }, 400)
      bridge = acrossV5Request(JSON.parse(body))
      path = '/v1/quotes'
    } else if (action === 'capabilities') {
      path = '/v1/capabilities?' + capabilities(url.searchParams).toString()
    } else {
      if (!acrossOrderId(orderId) || url.searchParams.size !== 1) return json({ error: 'Invalid order ID' }, 400)
      path = '/v1/transfers/' + orderId
    }
  } catch {
    return json({ error: 'Invalid Across request' }, 400)
  }

  try {
    const limiter = env.OPHIS_RELAY_RATE_LIMITER
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'
    if (!(await admitted(limiter, `across:${action}:${ip}`, !quote)) ||
        !(await admitted(limiter, `across:${quote ? 'quotes' : 'reads'}`, !quote))) {
      return json({ error: 'Rate limited' }, 429)
    }
    const body = bridge && {
      origin: {
        token: { chainId: bridge.originChainId, address: bridge.inputToken },
        amount: bridge.amount,
        depositor: bridge.depositor,
      },
      destination: {
        token: { chainId: bridge.destinationChainId, address: bridge.outputToken },
        recipient: bridge.recipient,
      },
      amountType: 'exact_input',
      capabilities: { operations: OPERATIONS },
      authorizationPolicy: { allowedTypes: ['approval'], approvalAmount: 'exact' },
      appFeeBps: fee,
    }
    const response = await fetch('https://api.across.to' + path, {
      method: request.method, redirect: 'manual', signal: AbortSignal.timeout(7_000),
      headers: { authorization: `Bearer ${env.ACROSS_API_KEY}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (action === 'status' && response.status === 404) return json({ status: 'in_progress' })
    if (!response.ok) return json({ error: 'Across request failed' }, response.status === 429 ? 429 : 502)
    const data: unknown = await response.json()
    if (bridge) return json(parseAcrossV5Quote(data, bridge, fee))
    if (orderId) return json(parseAcrossV5Status(data, orderId))
    const result = data as { originTokens?: unknown; destinationTokens?: unknown; pagination?: unknown }
    return json({ originTokens: result.originTokens, destinationTokens: result.destinationTokens, pagination: result.pagination })
  } catch {
    return json({ error: 'Across is temporarily unavailable' }, 502)
  }
}
