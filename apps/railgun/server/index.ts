import { RPC_BATCH_SIZE, RAILGUN_PROXY, RAILGUN_PROXIES, isAlchemyUrl, alchemyCU, isValidationCloudUrl, validationCloudCU, zanRpcUrl } from '../rpc-policy'
export { ValidationCloudBudget } from './budget'

const METHODS = new Set([
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getLogs',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_sendRawTransaction',
  'debug_traceCall',
  'anvil_metadata',
  'hardhat_metadata',
])
const MAX_BODY = 262_144
const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}
type RPCCall = { jsonrpc: '2.0'; id: string | number | null; method: string; params: unknown[] }

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: HEADERS })
}

async function readBody(request: Request | Response, maximum = MAX_BODY): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error('JSON body required.')
  const parts: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > maximum) {
      await reader.cancel()
      throw new Error('RPC body exceeds its supported size.')
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

export function rpcCall(value: unknown, proxy = RAILGUN_PROXY): RPCCall {
  if (!value || typeof value !== 'object') throw new Error('Invalid JSON-RPC request.')
  const item = value as Record<string, unknown>
  if (
    item.jsonrpc !== '2.0' ||
    typeof item.method !== 'string' ||
    !METHODS.has(item.method) ||
    !Array.isArray(item.params) ||
    !('id' in item) ||
    (typeof item.id !== 'string' && typeof item.id !== 'number' && item.id !== null)
  )
    throw new Error('Unsupported JSON-RPC request.')
  const params = [...item.params]
  if (item.method === 'eth_call' || item.method === 'eth_estimateGas') {
    const transaction = params[0]
    if (!transaction || typeof transaction !== 'object') throw new Error('Transaction required.')
    const gas = 'gas' in transaction ? transaction.gas : '0x1c9c380'
    if (typeof gas !== 'string' || !/^0x[0-9a-f]+$/i.test(gas) || BigInt(gas) > 30_000_000n)
      throw new Error('Simulation gas exceeds the supported limit.')
    params[0] = { ...transaction, gas }
  }
  if (
    item.method === 'eth_feeHistory' &&
    (typeof params[0] !== 'string' || !/^0x[0-9a-f]+$/i.test(params[0]) || BigInt(params[0]) > 64n)
  )
    throw new Error('Fee history is limited to 64 blocks.')
  if (item.method === 'eth_getLogs') {
    const filter = params[0]
    if (!filter || typeof filter !== 'object' || !('address' in filter))
      throw new Error('Railgun log filter required.')
    const addresses = Array.isArray(filter.address) ? filter.address : [filter.address]
    if (
      addresses.length !== 1 ||
      typeof addresses[0] !== 'string' ||
      addresses[0].toLowerCase() !== proxy
    )
      throw new Error('Only the selected network Railgun V2 logs are supported.')
    if ('blockHash' in filter) {
      if (
        typeof filter.blockHash !== 'string' ||
        !/^0x[0-9a-f]{64}$/i.test(filter.blockHash) ||
        'fromBlock' in filter ||
        'toBlock' in filter
      )
        throw new Error('Invalid log block hash.')
    } else {
      const from = 'fromBlock' in filter ? filter.fromBlock : undefined
      const to = 'toBlock' in filter ? filter.toBlock : undefined
      if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        !/^0x[0-9a-f]+$/i.test(from) ||
        !/^0x[0-9a-f]+$/i.test(to) ||
        BigInt(to) < BigInt(from) ||
        BigInt(to) - BigInt(from) >= 500n
      )
        throw new Error('Railgun log queries require an explicit range of at most 500 blocks.')
    }
  }
  if (item.method === 'debug_traceCall') {
    const [transaction, block, options] = params
    if (
      params.length !== 3 ||
      !transaction ||
      typeof transaction !== 'object' ||
      !options ||
      typeof options !== 'object' ||
      !('tracer' in options) ||
      options.tracer !== 'callTracer' ||
      !('gas' in transaction) ||
      typeof transaction.gas !== 'string' ||
      !/^0x[0-9a-f]+$/i.test(transaction.gas) ||
      BigInt(transaction.gas) > 30_000_000n
    )
      throw new Error('Only bounded callTracer simulations are supported.')
    params.splice(0, params.length, transaction, block, { tracer: 'callTracer', timeout: '5s' })
  }
  return { jsonrpc: '2.0', id: item.id, method: item.method, params }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/rpc' && !url.pathname.startsWith('/rpc/')) return error(404, 'RPC route not found.')
    const match = /^\/rpc(?:\/(1|42161|137|56))?$/.exec(url.pathname)
    if (!match) return error(404, 'Unsupported private network.')
    const chainId = Number(match[1] || 1)
    const proxy = RAILGUN_PROXIES[chainId]
    const endpoints: Record<number, { url?: string; token?: string }> = {
      1: { url: env.RAILGUN_RPC_URL, token: env.RAILGUN_RPC_TOKEN },
      42161: { url: env.RAILGUN_ARBITRUM_RPC_URL || zanRpcUrl(42161, env.RAILGUN_ZAN_API_KEY), token: env.RAILGUN_ARBITRUM_RPC_TOKEN },
      137: { url: env.RAILGUN_POLYGON_RPC_URL || zanRpcUrl(137, env.RAILGUN_ZAN_API_KEY), token: env.RAILGUN_POLYGON_RPC_TOKEN },
      56: { url: env.RAILGUN_BNB_RPC_URL || zanRpcUrl(56, env.RAILGUN_ZAN_API_KEY), token: env.RAILGUN_BNB_RPC_TOKEN },
    }
    const { url: upstreamUrl, token: upstreamToken } = endpoints[chainId]
    if (request.method !== 'POST') return error(405, 'POST required.')
    if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin)
      return error(403, 'Same-origin requests only.')
    if (env.RAILGUN_RPC_ENABLED !== 'true' || !upstreamUrl)
      return error(503, 'Private wallet RPC is not enabled.')
    if (
      request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json'
    )
      return error(415, 'JSON content type required.')
    const key = request.headers.get('CF-Connecting-IP') || 'local'
    let payload: RPCCall | RPCCall[]
    try {
      const parsed = await readBody(request)
      if (Array.isArray(parsed) && (parsed.length === 0 || parsed.length > RPC_BATCH_SIZE))
        throw new Error('RPC batches require 1 to 20 calls.')
      payload = Array.isArray(parsed) ? parsed.map((item) => rpcCall(item, proxy)) : rpcCall(parsed, proxy)
    } catch (cause) {
      return error(400, cause instanceof Error ? cause.message : 'Invalid RPC body.')
    }
    const calls = Array.isArray(payload) ? payload : [payload]
    for (const call of calls) {
      if (!(await env.RPC_LIMIT.limit({ key })).success)
        return error(429, 'RPC rate limit reached. Retry shortly.')
      if (call.method === 'debug_traceCall' && !(await env.TRACE_LIMIT.limit({ key })).success)
        return error(429, 'Simulation rate limit reached. Retry shortly.')
    }
    try {
      const alchemy = isAlchemyUrl(chainId, upstreamUrl)
      const extendedEndpoints: Record<number, string | undefined> = {
        42161: env.RAILGUN_ARBITRUM_VALIDATION_CLOUD_URL,
        137: env.RAILGUN_POLYGON_VALIDATION_CLOUD_URL,
        56: env.RAILGUN_BNB_VALIDATION_CLOUD_URL,
      }
      const extended = alchemy && calls.some((call) => call.method === 'debug_traceCall' || call.method === 'eth_getLogs')
      const extendedUrl = extendedEndpoints[chainId]
      if (extended && (!extendedUrl || !isValidationCloudUrl(chainId, extendedUrl)))
        return error(503, 'A verified Validation Cloud endpoint is required for traces and log scans on Alchemy Free.')
      const upstream = new URL(extended ? extendedUrl! : upstreamUrl)
      const validationCloud = isValidationCloudUrl(chainId, upstream.href)
      const token = alchemy ? undefined : upstreamToken
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      if (!local && !token && !validationCloud && !alchemy && upstream.href !== zanRpcUrl(chainId, env.RAILGUN_ZAN_API_KEY))
        return error(503, 'Trusted RPC authentication is not configured.')
      if (
        upstream.protocol !== 'https:' &&
        !(
          local &&
          upstream.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname)
        )
      )
        return error(503, 'A trusted HTTPS RPC is required.')
      const execution = calls.some((call) => ['eth_call', 'eth_estimateGas', 'debug_traceCall', 'eth_sendRawTransaction'].includes(call.method))
      const zan = alchemy ? undefined : zanRpcUrl(chainId, env.RAILGUN_ZAN_API_KEY)
      const priced = calls.every((call) => (alchemy && !extended ? alchemyCU(call.method) : validationCloudCU(call.method)) !== undefined)
      if (alchemy && !priced) return error(400, 'RPC batches require methods supported by the selected free provider with verified CU costs.')
      if (validationCloud && execution && !priced) return error(400, 'Execution batches require methods with verified CU costs.')
      if (validationCloud && !priced && !zan) return error(503, 'This RPC method requires the configured ZAN transport.')
      // Execution data goes to one configured provider; only ordinary reads may fail over.
      const first = validationCloud && !execution && zan ? zan : upstream.href
      const fallback = validationCloud && priced && first !== upstream.href
      const forward = async (target: string): Promise<Response> => {
        if ((validationCloud || alchemy) && target === upstream.href) {
          const provider = validationCloud ? 'validationCloud' : 'alchemy'
          if (!env.VALIDATION_CLOUD_BUDGET) return error(503, 'RPC budget guard is not configured.')
          try {
            const stub = env.VALIDATION_CLOUD_BUDGET.getByName(validationCloud ? 'shared-account' : 'alchemy-shared-account')
            const methods = calls.map((call) => call.method)
            const budget = validationCloud ? await stub.consume(methods) : await stub.consume(methods, provider)
            if (!budget.allowed) return error(429, budget.reason || 'Shared RPC budget reached.')
          } catch {
            return error(503, 'RPC budget guard unavailable. Retry without clearing pending transactions.')
          }
        }
        return fetch(target, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Ophis-Private-Wallet/1.0',
            ...(alchemy && !extended ? { Origin: 'https://swap.ophis.fi' } : {}),
            ...(target === upstream.href && token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          redirect: 'manual',
          signal: AbortSignal.timeout(30_000),
        })
      }
      let target = first
      let response: Response
      try { response = await forward(target) }
      catch (cause) {
        if (!fallback || target === upstream.href) throw cause
        target = upstream.href
        response = await forward(target)
      }
      if (fallback && target !== upstream.href && (response.status === 429 || response.status >= 500)) {
        await response.body?.cancel()
        response = await forward(upstream.href)
      } else if (fallback && target !== upstream.href && response.ok) {
        let result: unknown
        try { result = await readBody(response, 8_388_608) }
        catch { target = upstream.href; response = await forward(target) }
        if (target !== upstream.href) {
          const replies = Array.isArray(result) ? result : [result]
          const limited = replies.some((reply) => reply && typeof reply === 'object' && 'error' in reply
            && /rate|limit|capacity|quota/i.test(String((reply.error as { message?: string })?.message)))
          response = limited ? await forward(upstream.href) : Response.json(result)
        }
      }
      if (response.status >= 300 && response.status < 400)
        return error(502, 'Trusted RPC redirects are disabled.')
      return new Response(response.body, { status: response.status, headers: HEADERS })
    } catch {
      return error(502, 'Trusted RPC unavailable. Retry without clearing pending transactions.')
    }
  },
}
