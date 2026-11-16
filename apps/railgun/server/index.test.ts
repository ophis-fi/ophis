import { afterEach, expect, it, vi } from 'vitest'
import gateway, { rpcCall } from './index'
import { FetchRequest, JsonRpcProvider } from 'ethers'
import { timingSafeEqual } from 'node:crypto'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { RPC_BATCH_SIZE, RAILGUN_PROXY, RAILGUN_PROXIES, isAlchemyUrl, isValidationCloudUrl, zanRpcUrl } from '../rpc-policy'

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

function budgetBinding(reserve = vi.fn().mockReturnValue({ allowed: true })): Env['VALIDATION_CLOUD_BUDGET'] {
  return { getByName: vi.fn().mockReturnValue({ consume: reserve }), get: vi.fn(), newUniqueId: vi.fn(),
    idFromName: vi.fn(), idFromString: vi.fn(), jurisdiction: vi.fn() }
}
const enabled = {
  VALIDATION_CLOUD_BUDGET: budgetBinding(),
  RAILGUN_RPC_ENABLED: 'true',
  RAILGUN_RPC_URL: 'https://trusted-rpc.example',
  RAILGUN_RPC_TOKEN: 'server-only-test-token',
  RPC_LIMIT: { limit: async () => ({ success: true }) },
  TRACE_LIMIT: { limit: async () => ({ success: true }) },
  ASSETS: {
    fetch: async () => new Response('static asset'),
    connect: () => {
      throw new Error('Unexpected socket connection')
    },
  },
}
function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://wallet.example/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}
const chain = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }
afterEach(() => vi.unstubAllGlobals())

const vcURL = 'https://mainnet.arbitrum.validationcloud.io/v1/test-key'
function vcEnv(reserve = vi.fn().mockReturnValue({ allowed: true })) {
  return { ...enabled, RAILGUN_ARBITRUM_RPC_URL: vcURL, RAILGUN_ZAN_API_KEY: 'test-zan',
    VALIDATION_CLOUD_BUDGET: budgetBinding(reserve),
  }
}
function arbitrum(body: unknown): Request {
  return new Request('https://swap.ophis.fi/rpc/42161', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
}

const alchemyURL = 'https://arb-mainnet.g.alchemy.com/v2/test-key'
function alchemyEnv(reserve = vi.fn().mockReturnValue({ allowed: true })) {
  return { ...vcEnv(reserve), RAILGUN_ARBITRUM_RPC_URL: alchemyURL, RAILGUN_ARBITRUM_VALIDATION_CLOUD_URL: vcURL }
}

it.each([false, true])('preserves a canonical block-hash eth_call without replay or numeric fallback (unsupported: %s)', async unsupported => {
  const selector = { blockHash: `0x${'66'.repeat(32)}`, requireCanonical: true }
  const payload = { jsonrpc: '2.0', id: 7, method: 'eth_call', params: [{ to: RAILGUN_PROXIES[42161], data: '0x12345678' }, selector] }
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const upstream = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => {
    const forwarded = JSON.parse(String(init?.body))
    expect(forwarded.params[1]).toEqual(selector)
    expect(forwarded.params).toHaveLength(2)
    expect(forwarded.params[0]).toEqual({ ...payload.params[0], gas: '0x1c9c380' })
    return Response.json(unsupported
      ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'Block selector unsupported' } }
      : { jsonrpc: '2.0', id: 7, result: `0x${'00'.repeat(32)}` })
  })
  vi.stubGlobal('fetch', upstream)
  const response = await gateway.fetch(arbitrum(payload), alchemyEnv(reserve))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(unsupported
    ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'invalid RPC parameters' } }
    : { jsonrpc: '2.0', id: 7, result: `0x${'00'.repeat(32)}` })
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(upstream.mock.calls[0][0]).toBe(alchemyURL)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['eth_call'], 'alchemy')
})

function diagnosticCrypto() {
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  vi.stubGlobal('crypto', { subtle: { digest,
    timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => timingSafeEqual(new Uint8Array(a), new Uint8Array(b)),
  } })
}

it.each([false, true])('preserves a canonical block-hash eth_getCode without replay or numeric fallback (unsupported: %s)', async unsupported => {
  const selector = { blockHash: `0x${'66'.repeat(32)}`, requireCanonical: true }
  const payload = { jsonrpc: '2.0', id: 7, method: 'eth_getCode', params: [RAILGUN_PROXIES[42161], selector] }
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const upstream = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).params).toEqual(payload.params)
    return Response.json(unsupported
      ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'Block selector unsupported' } }
      : { jsonrpc: '2.0', id: 7, result: '0x6001600055' })
  })
  vi.stubGlobal('fetch', upstream)
  const response = await gateway.fetch(arbitrum(payload), alchemyEnv(reserve))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual(unsupported
    ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'invalid RPC parameters' } }
    : { jsonrpc: '2.0', id: 7, result: '0x6001600055' })
  expect(upstream).toHaveBeenCalledTimes(1)
  expect(upstream.mock.calls[0][0]).toBe(alchemyURL)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['eth_getCode'], 'alchemy')
})
function probe(provider: string, token?: string): Request {
  return new Request(`https://swap.ophis.fi/rpc/budget/${provider}`, {
    method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

it.each(['eth_getTransactionCount', 'eth_getBalance', 'eth_getStorageAt'].flatMap(method =>
  [false, true].map(unsupported => ({ method, unsupported }))))('preserves Arbitrum recovery selectors: $method, unsupported $unsupported', async ({ method, unsupported }) => {
  const selector = { blockHash: `0x${'66'.repeat(32)}`, requireCanonical: true }
  const params = method === 'eth_getStorageAt' ? [RAILGUN_PROXIES[42161], '0x0', selector] : [RAILGUN_PROXIES[42161], selector]
  const payload = { jsonrpc: '2.0', id: 7, method, params }
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const result = method === 'eth_getStorageAt' ? `0x${'00'.repeat(32)}` : '0x0'
  const upstream = vi.fn(async (_target: string | URL | Request, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body)).params).toEqual(params)
    return Response.json(unsupported ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'Hash selector unsupported' } }
      : { jsonrpc: '2.0', id: 7, result })
  })
  vi.stubGlobal('fetch', upstream)
  const response = await gateway.fetch(arbitrum(payload), alchemyEnv(reserve))
  expect(await response.json()).toEqual(unsupported
    ? { jsonrpc: '2.0', id: 7, error: { code: -32602, message: 'invalid RPC parameters' } }
    : { jsonrpc: '2.0', id: 7, result })
  expect(upstream).toHaveBeenCalledExactlyOnceWith(alchemyURL, expect.anything())
  expect(reserve).toHaveBeenCalledExactlyOnceWith([method], 'alchemy')
})

it.each([undefined, '', 'wrong-secret'])('rejects diagnostic credentials %s before accessing a budget or upstream', async (token) => {
  diagnosticCrypto()
  const env = alchemyEnv()
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const response = await gateway.fetch(probe('alchemy', token), env)
  expect(response.status).toBe(403)
  expect(await response.json()).toEqual({ error: 'Forbidden.' })
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).not.toHaveBeenCalled()
  expect(upstream).not.toHaveBeenCalled()
})

it('probes only a fixed chain-id budget reservation and never forwards the deployment bearer', async () => {
  diagnosticCrypto()
  const reserve = vi.fn().mockReturnValue({ allowed: true, remainingCU: 23_999_990 })
  const env = alchemyEnv(reserve)
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  for (const provider of ['alchemy', 'validationCloud']) {
    const response = await gateway.fetch(probe(provider, enabled.RAILGUN_RPC_TOKEN), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  }
  expect(reserve.mock.calls).toEqual([[['eth_chainId'], 'alchemy'], [['eth_chainId']]])
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).toHaveBeenCalledWith('alchemy-shared-account')
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).toHaveBeenCalledWith('shared-account')
  expect((await gateway.fetch(probe('unsupported', enabled.RAILGUN_RPC_TOKEN), env)).status).toBe(404)
  expect((await gateway.fetch(probe('alchemy', enabled.RAILGUN_RPC_TOKEN), { ...env, RAILGUN_RPC_TOKEN: undefined })).status).toBe(403)
  expect(upstream).not.toHaveBeenCalled()
})

it('returns bounded sanitized diagnostic fields only to the authorized deployment client', async () => {
  diagnosticCrypto()
  const message = `SQLITE_ERROR: path-secret query-key. ${'row '.repeat(116)}${enabled.RAILGUN_RPC_TOKEN} ${alchemyURL} test-key Bearer short-secret`
  const cause = Object.assign(new Error(message), { remote: true, retryable: false, overloaded: false })
  const env = alchemyEnv(vi.fn().mockRejectedValue(cause))
  env.RAILGUN_RPC_URL = 'https://rpc.example/path-secret/?key=query-key'
  const response = await gateway.fetch(probe('alchemy', enabled.RAILGUN_RPC_TOKEN), env)
  const result = await response.json<{ diagnostic: { stage: string; remote: boolean; message: string } }>()
  expect(response.status).toBe(503)
  expect(result.diagnostic.stage).toBe('consume')
  expect(result.diagnostic.remote).toBe(true)
  expect(result.diagnostic.message.length).toBeLessThanOrEqual(500)
  const serialized = JSON.stringify(result)
  for (const secret of [enabled.RAILGUN_RPC_TOKEN, 'server-o', alchemyURL, 'test-key', 'path-secret', 'query-key', 'short-secret', cause.stack])
    expect(serialized).not.toContain(secret)
  expect(result.diagnostic).not.toHaveProperty('stack')
  const publicResponse = await gateway.fetch(arbitrum(chain), env)
  expect(await publicResponse.json()).toEqual({ error: 'RPC budget guard unavailable. Retry without clearing pending transactions.' })
})

it('bounds diagnostic methods, origins and rates and identifies a namespace lookup failure', async () => {
  diagnosticCrypto()
  const env = alchemyEnv()
  const authorized = probe('alchemy', enabled.RAILGUN_RPC_TOKEN)
  expect((await gateway.fetch(new Request(authorized, { method: 'GET' }), env)).status).toBe(405)
  expect((await gateway.fetch(new Request(authorized, { headers: {
    Authorization: `Bearer ${enabled.RAILGUN_RPC_TOKEN}`, Origin: 'https://untrusted.example',
  } }), env)).status).toBe(403)
  expect((await gateway.fetch(authorized, { ...env, RPC_LIMIT: { limit: async () => ({ success: false }) } })).status).toBe(429)
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).not.toHaveBeenCalled()
  vi.mocked(env.VALIDATION_CLOUD_BUDGET.getByName).mockImplementation(() => { throw new Error('Namespace lookup failed.') })
  const result = await (await gateway.fetch(probe('alchemy', enabled.RAILGUN_RPC_TOKEN), env)).json<{ diagnostic: { stage: string } }>()
  expect(result.diagnostic.stage).toBe('lookup')
})

it('uses Alchemy for a quote and reserves its shared budget without contacting ZAN', async () => {
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const env = alchemyEnv(reserve)
  const withLegacyToken = { ...env, RAILGUN_ARBITRUM_RPC_TOKEN: 'unrelated-legacy-secret' }
  const upstream = vi.fn().mockResolvedValue(Response.json({ ...chain, result: '0x01' }))
  vi.stubGlobal('fetch', upstream)
  expect((await gateway.fetch(arbitrum({ ...chain, method: 'eth_call', params: [{ data: '0x1234' }] }), withLegacyToken)).status).toBe(200)
  expect(upstream).toHaveBeenCalledOnce()
  expect(String(upstream.mock.calls[0][0])).toBe(alchemyURL)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['eth_call'], 'alchemy')
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).toHaveBeenCalledWith('alchemy-shared-account')
  expect(upstream.mock.calls[0][1].headers).not.toHaveProperty('Authorization')
  expect(upstream.mock.calls[0][1].headers.Origin).toBe('https://swap.ophis.fi')
})

it('serves height-only batches through the shared meter and preserves every caller ID', async () => {
  const env = alchemyEnv(), upstream = vi.fn()
  const blockNumber = vi.fn().mockResolvedValue('0x123')
  Object.assign(env.VALIDATION_CLOUD_BUDGET.getByName('alchemy-shared-account'), { blockNumber })
  vi.stubGlobal('fetch', upstream)
  const calls = [7, 'scan'].map((id) => ({ ...chain, id, method: 'eth_blockNumber' }))
  const response = await gateway.fetch(arbitrum(calls), env)
  expect(await response.json()).toEqual(calls.map(({ id }) => ({ jsonrpc: '2.0', id, result: '0x123' })))
  expect(blockNumber).toHaveBeenCalledExactlyOnceWith(42161, alchemyURL)
  expect(upstream).not.toHaveBeenCalled()
})

it('never routes a signed transaction to the history provider through a mixed batch', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const calls = [{ ...chain, method: 'eth_sendRawTransaction', params: ['0x1234'] },
    { ...chain, id: 2, method: 'eth_getLogs', params: [{ address: RAILGUN_PROXIES[42161], fromBlock: '0x1', toBlock: '0x2' }] }]
  expect((await gateway.fetch(arbitrum(calls), alchemyEnv())).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})

it.each(['debug_traceCall', 'eth_getLogs'])('routes %s directly to Validation Cloud without probing Alchemy', async (method) => {
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const env = alchemyEnv(reserve)
  const upstream = vi.fn().mockResolvedValue(Response.json({ ...chain, result: [] }))
  vi.stubGlobal('fetch', upstream)
  const params = method === 'eth_getLogs'
    ? [{ address: RAILGUN_PROXIES[42161], fromBlock: '0x1', toBlock: '0x1f4' }]
    : [{ gas: '0x1c9c380' }, 'latest', { tracer: 'callTracer' }]
  expect((await gateway.fetch(arbitrum({ ...chain, method, params }), env)).status).toBe(200)
  expect(upstream).toHaveBeenCalledOnce()
  expect(String(upstream.mock.calls[0][0])).toBe(vcURL)
  expect(reserve).toHaveBeenCalledExactlyOnceWith([method])
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).toHaveBeenCalledWith('shared-account')
  expect((await gateway.fetch(arbitrum({ ...chain, method, params }), { ...env, RAILGUN_ARBITRUM_VALIDATION_CLOUD_URL: undefined })).status).toBe(503)
  expect(upstream).toHaveBeenCalledOnce()
})

it.each([[42161, 'arb']] as const)('uses the explicitly qualified paid Alchemy history route for chain %s', async (chainId, prefix) => {
  const reserve = vi.fn().mockReturnValue({ allowed: true }), env = { ...alchemyEnv(reserve),
    RAILGUN_ARBITRUM_ALCHEMY_EXTENDED: 'true' }
  const upstream = vi.fn().mockImplementation(async () => Response.json({ ...chain, result: [] }))
  vi.stubGlobal('fetch', upstream)
  const trace = { ...chain, method: 'debug_traceCall', params: [{ gas: '0x186a0' }, 'latest', { tracer: 'callTracer' }] }
  const logs = { ...chain, method: 'eth_getLogs', params: [{ address: RAILGUN_PROXIES[chainId], fromBlock: '0x1', toBlock: '0x1f4' }] }
  const rpc = (body: unknown) => new Request(`https://swap.ophis.fi/rpc/${chainId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await gateway.fetch(rpc([trace, logs]), env)).status).toBe(200)
  expect(upstream).toHaveBeenCalledOnce()
  expect(upstream.mock.calls[0][0]).toBe(`https://${prefix}-mainnet.g.alchemy.com/v2/test-key`)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['debug_traceCall', 'eth_getLogs'], 'alchemy')
  expect((await gateway.fetch(rpc([logs, { ...chain, method: 'eth_sendRawTransaction', params: ['0x1234'] }]), env)).status).toBe(400)
  expect(upstream).toHaveBeenCalledOnce()
  upstream.mockRejectedValueOnce(new Error('private provider credential'))
  const failure = await gateway.fetch(rpc(trace), env)
  expect(failure.status).toBe(502)
  expect(await failure.text()).not.toContain('private provider credential')
  expect(upstream).toHaveBeenCalledTimes(2)
})

it.each(['eth_call', 'eth_estimateGas', 'eth_sendRawTransaction'])('never retries %s through another provider after an Alchemy failure', async (method) => {
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const upstream = vi.fn().mockRejectedValue(new Error('offline'))
  vi.stubGlobal('fetch', upstream)
  const params = method === 'eth_sendRawTransaction' ? ['0x1234'] : [{ data: '0x1234', authorizationList: [] }]
  expect((await gateway.fetch(arbitrum({ ...chain, method, params }), alchemyEnv(reserve))).status).toBe(502)
  expect(upstream).toHaveBeenCalledOnce()
  expect(String(upstream.mock.calls[0][0])).toBe(alchemyURL)
})

it('rejects exhausted or unavailable Alchemy meters before forwarding and does not expose exceptions', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const exhausted = alchemyEnv(vi.fn().mockReturnValue({ allowed: false, reason: 'Alchemy shared CU budget reached.' }))
  expect((await gateway.fetch(arbitrum(chain), exhausted)).status).toBe(429)
  const broken = alchemyEnv(vi.fn().mockRejectedValue(new Error('secret-in-error')))
  const response = await gateway.fetch(arbitrum(chain), broken)
  expect(response.status).toBe(503)
  expect(await response.text()).toContain('budget guard unavailable')
  expect(upstream).not.toHaveBeenCalled()
})

it.each([[42161, 'arb'], [137, 'polygon'], [56, 'bnb'], [8453, 'base']] as const)('pins Alchemy to chain %s and rejects edited credentials', (chainId, prefix) => {
  const url = `https://${prefix}-mainnet.g.alchemy.com/v2/test-key`
  expect(isAlchemyUrl(chainId, url)).toBe(true)
  for (const edited of [url + '?extra=1', url + '#fragment', url.replace('https:', 'http:'), url.replace('/v2/', ':8443/v2/'), url.replace('-mainnet.', '-mainnet.evil.'), url.replace('https://', 'https://key@')])
    expect(isAlchemyUrl(chainId, edited)).toBe(false)
  expect(isAlchemyUrl(1, url)).toBe(false)
})

it('rejects mixed unpriced execution batches without contacting either provider', async () => {
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const mixed = [{ ...chain, method: 'hardhat_metadata' }, { ...chain, method: 'eth_call', params: [{ data: '0x1234' }] }]
  expect(rpcCall(mixed[0]).method).toBe('hardhat_metadata')
  expect((await gateway.fetch(arbitrum(mixed), alchemyEnv())).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
})

it('meters execution checks once on the configured Validation Cloud endpoint without disclosing them to another provider', async () => {
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const upstream = vi.fn().mockResolvedValue(new Response('upstream unavailable', { status: 503 }))
  vi.stubGlobal('fetch', upstream)
  const transaction = { to: RAILGUN_PROXIES[42161], data: '0x1234', authorizationList: [{ chainId: '0xa4b1' }] }
  expect((await gateway.fetch(arbitrum({ ...chain, method: 'eth_call', params: [transaction, 'latest'] }), vcEnv(reserve))).status).toBe(503)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['eth_call'])
  expect(upstream).toHaveBeenCalledOnce()
  expect(String(upstream.mock.calls[0][0])).toBe(vcURL)
  expect(JSON.parse(upstream.mock.calls[0][1].body).params[0]).toEqual({ ...transaction, gas: '0x1c9c380' })
})

it('keeps ordinary reads on ZAN without spending Validation Cloud credits', async () => {
  const reserve = vi.fn()
  const upstream = vi.fn().mockResolvedValue(Response.json({ ...chain, result: '0xa4b1' }))
  vi.stubGlobal('fetch', upstream)
  expect((await gateway.fetch(arbitrum(chain), vcEnv(reserve))).status).toBe(200)
  expect(String(upstream.mock.calls[0][0])).toBe(zanRpcUrl(42161, 'test-zan'))
  expect(reserve).not.toHaveBeenCalled()
})

it('keeps methods with undocumented CU costs off Validation Cloud, including after a ZAN failure', async () => {
  const reserve = vi.fn()
  const upstream = vi.fn().mockResolvedValue(new Response(null, { status: 429 }))
  vi.stubGlobal('fetch', upstream)
  const feeHistory = { ...chain, method: 'eth_feeHistory', params: ['0x1', 'latest', []] }
  expect((await gateway.fetch(arbitrum(feeHistory), vcEnv(reserve))).status).toBe(429)
  expect(upstream).toHaveBeenCalledOnce()
  expect(String(upstream.mock.calls[0][0])).toBe(zanRpcUrl(42161, 'test-zan'))
  expect(reserve).not.toHaveBeenCalled()
  const mixed = [feeHistory, { ...chain, method: 'eth_call', params: [{ data: '0x1234', authorizationList: [{ chainId: '0xa4b1' }] }] }]
  upstream.mockClear()
  expect((await gateway.fetch(arbitrum(mixed), vcEnv(reserve))).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  expect(reserve).not.toHaveBeenCalled()
})

it.each(['http', 'json', 'network', 'body'])('allows at most one metered read fallback after a %s failure', async (failure) => {
  const reserve = vi.fn().mockReturnValue({ allowed: true })
  const upstream = vi.fn()
  if (failure === 'network') upstream.mockRejectedValueOnce(new Error('offline'))
  else if (failure === 'body') upstream.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.error(new Error('truncated')) } })))
  else upstream.mockResolvedValueOnce(failure === 'http' ? new Response(null, { status: 429 }) : Response.json({ ...chain, error: { code: -32005, message: 'rate limit exceeded' } }))
  upstream.mockResolvedValue(new Response(null, { status: 503 }))
  vi.stubGlobal('fetch', upstream)
  expect((await gateway.fetch(arbitrum(chain), vcEnv(reserve))).status).toBe(503)
  expect(upstream).toHaveBeenCalledTimes(2)
  expect(String(upstream.mock.calls[1][0])).toBe(vcURL)
  expect(reserve).toHaveBeenCalledExactlyOnceWith(['eth_chainId'])
})

it('stops before contacting Validation Cloud when the shared budget is exhausted', async () => {
  const reserve = vi.fn().mockReturnValue({ allowed: false, reason: 'shared CU budget reached' })
  const upstream = vi.fn()
  vi.stubGlobal('fetch', upstream)
  const response = await gateway.fetch(arbitrum({ ...chain, method: 'eth_call', params: [{ to: RAILGUN_PROXIES[42161] }] }), vcEnv(reserve))
  expect(response.status).toBe(429)
  expect(await response.text()).toContain('shared CU budget')
  expect(upstream).not.toHaveBeenCalled()
})

it('pins Validation Cloud to the selected network and rejects edited URLs', () => {
  expect(isValidationCloudUrl(42161, vcURL)).toBe(true)
  for (const url of [vcURL + '?extra=1', vcURL + '#fragment', vcURL.replace('https:', 'http:'), vcURL.replace('arbitrum', 'bsc'), vcURL.replace('/v1/', ':8443/v1/'), vcURL.replace('mainnet.', 'key@mainnet.')]) {
    expect(isValidationCloudUrl(42161, url)).toBe(false)
  }
})

it.each([[42161, 'ARBITRUM'], [56, 'BNB']] as const)(
  'uses a server-only provider key on the pinned chain %s endpoint and rejects edited URLs',
  async (chainId, name) => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: `0x${chainId.toString(16)}` }))
    vi.stubGlobal('fetch', upstream)
    const call = (): Request => new Request(`https://swap.ophis.fi/rpc/${chainId}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chain),
    })
    const env = { ...enabled, RAILGUN_ZAN_API_KEY: 'test-key/encoded' }
    expect((await gateway.fetch(call(), env)).status).toBe(200)
    expect(upstream).toHaveBeenCalledOnce()
    expect(String(upstream.mock.calls[0][0])).toBe(zanRpcUrl(chainId, env.RAILGUN_ZAN_API_KEY))
    expect(upstream.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization')
    const edited = { ...env, [`RAILGUN_${name}_RPC_URL`]: `${zanRpcUrl(chainId, env.RAILGUN_ZAN_API_KEY)}?unapproved=query` }
    expect((await gateway.fetch(call(), edited)).status).toBe(503)
    expect(upstream).toHaveBeenCalledOnce()
    expect((await gateway.fetch(call(), enabled)).status).toBe(503)
  },
)

it('bounds expensive reads, preserves supplied execution data and matches the SDK log contract', () => {
  expect(RAILGUN_PROXY).toBe(NETWORK_CONFIG[NetworkName.Ethereum].proxyContract.toLowerCase())
  for (const method of ['eth_call', 'eth_estimateGas']) {
    expect(() => rpcCall({ ...chain, method, params: [{ gas: '0xffffffffffffffff' }] })).toThrow()
    const authorizationList = [{ address: RAILGUN_PROXY }]
    const bounded = rpcCall({
      ...chain,
      method,
      params: [{ data: '0x1234', authorizationList }, 'latest'],
    })
    expect(bounded.params[0]).toEqual({ data: '0x1234', authorizationList, gas: '0x1c9c380' })
  }
  expect(() =>
    rpcCall({ ...chain, method: 'eth_feeHistory', params: ['0xffffffffffff', 'latest', []] }),
  ).toThrow()
  expect(() =>
    rpcCall({ ...chain, method: 'eth_getLogs', params: [{ fromBlock: '0x0', toBlock: 'latest' }] }),
  ).toThrow()
  expect(() =>
    rpcCall({
      ...chain,
      method: 'eth_getLogs',
      params: [{ address: RAILGUN_PROXY, fromBlock: '0x0', toBlock: '0x1f4' }],
    }),
  ).toThrow()
  expect(
    rpcCall({
      ...chain,
      method: 'eth_getLogs',
      params: [{ address: RAILGUN_PROXY, fromBlock: '0x0', toBlock: '0x1f3' }],
    }).method,
  ).toBe('eth_getLogs')
})

it('splits an actual ethers burst within the gateway batch cap and charges every RPC call', async () => {
  const sizes: number[] = []
  const limit = vi.fn().mockResolvedValue({ success: true })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (_url, options) => {
    const payload = JSON.parse(String(options?.body))
    const calls = Array.isArray(payload) ? payload : [payload]
    sizes.push(calls.length)
    const replies = calls.map((call: { id: number }) => ({
      jsonrpc: '2.0',
      id: call.id,
      result: '0x1',
    }))
    return Response.json(Array.isArray(payload) ? replies : replies[0])
  })
  vi.stubGlobal('fetch', fetch)
  const transport = new FetchRequest('https://wallet.example/rpc')
  transport.getUrlFunc = async (req) => {
    const response = await gateway.fetch(
      new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body ? Uint8Array.from(req.body).buffer : undefined,
      }),
      { ...enabled, RPC_LIMIT: { limit } },
    )
    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(await response.arrayBuffer()),
    }
  }
  const provider = new JsonRpcProvider(transport, 1, {
    staticNetwork: true,
    batchMaxCount: RPC_BATCH_SIZE,
  })
  try {
    const balances = await Promise.all(
      Array.from({ length: 45 }, (_, i) =>
        provider.getBalance(`0x${(i + 1).toString(16).padStart(40, '0')}`),
      ),
    )
    expect(balances).toEqual(Array(45).fill(1n))
    expect(Math.max(...sizes)).toBe(RPC_BATCH_SIZE)
    expect(limit).toHaveBeenCalledTimes(45)
  } finally {
    provider.destroy()
  }
})

it('blocks disabled, cross-origin, oversized and unapproved RPC batches before reaching upstream', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(
    (await gateway.fetch(request(chain), { ...enabled, RAILGUN_RPC_ENABLED: 'false' })).status,
  ).toBe(503)
  expect(
    (await gateway.fetch(request(chain, { Origin: 'https://untrusted.example' }), enabled)).status,
  ).toBe(403)
  expect(
    (await gateway.fetch(request([chain, { ...chain, method: 'anvil_setBalance' }]), enabled))
      .status,
  ).toBe(400)
  expect(
    (await gateway.fetch(request({ ...chain, params: ['x'.repeat(262_144)] }), enabled)).status,
  ).toBe(400)
  expect(
    (
      await gateway.fetch(request(chain), {
        ...enabled,
        RAILGUN_RPC_URL: 'http://100.69.134.7:8547',
      })
    ).status,
  ).toBe(503)
  expect(
    (await gateway.fetch(request(chain), { ...enabled, RAILGUN_RPC_TOKEN: undefined })).status,
  ).toBe(503)
  expect(fetch).not.toHaveBeenCalled()
})

it('keeps authorization and calldata unchanged, bounds traces, and strips cookies and cache headers', async () => {
  const authorizationList = [
    {
      chainId: '0x1',
      address: `0x${'11'.repeat(20)}`,
      nonce: '0x0',
      r: '0x1',
      s: '0x2',
      yParity: '0x0',
    },
  ]
  const transaction = {
    to: `0x${'22'.repeat(20)}`,
    data: '0x1234',
    gas: '0x2dc6c0',
    authorizationList,
  }
  const call = {
    ...chain,
    method: 'debug_traceCall',
    params: [
      transaction,
      'latest',
      { tracer: 'callTracer', timeout: '999s', tracerConfig: { onlyTopCall: true } },
    ],
  }
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    new Response('{"jsonrpc":"2.0","id":1,"result":{"type":"CALL"}}', {
      headers: { 'Cache-Control': 'public', 'Set-Cookie': 'bad=1' },
    }),
  )
  vi.stubGlobal('fetch', fetch)
  const result = await gateway.fetch(
    request(call, { Cookie: 'wallet=private', Authorization: 'Bearer client-controlled' }),
    enabled,
  )
  expect(result.status).toBe(200)
  const options = fetch.mock.calls[0][1]
  if (!options) throw new Error('Upstream request options missing')
  const forwarded = JSON.parse(String(options.body))
  expect(forwarded.params).toEqual([transaction, 'latest', { tracer: 'callTracer', timeout: '5s' }])
  expect(options.headers).toEqual({
    'Content-Type': 'application/json',
    'User-Agent': 'Ophis-Private-Wallet/1.0',
    Authorization: 'Bearer server-only-test-token',
  })
  expect(options.redirect).toBe('manual')
  expect(result.headers.get('Cache-Control')).toBe('no-store')
  expect(result.headers.get('Set-Cookie')).toBeNull()
  expect(() =>
    rpcCall({ ...call, params: [transaction, 'latest', { tracer: 'custom javascript' }] }),
  ).toThrow()
  expect(() =>
    rpcCall({
      ...call,
      params: [{ ...transaction, gas: '0x100000000' }, 'latest', { tracer: 'callTracer' }],
    }),
  ).toThrow()
})

it('charges a trace rate-limit token for every trace in a batch and keeps upstream errors private', async () => {
  const trace = {
    ...chain,
    method: 'debug_traceCall',
    params: [{ gas: '0x2dc6c0' }, 'latest', { tracer: 'callTracer' }],
  }
  const limit = vi
    .fn()
    .mockResolvedValueOnce({ success: true })
    .mockResolvedValueOnce({ success: false })
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  expect(
    (await gateway.fetch(request([trace, trace]), { ...enabled, TRACE_LIMIT: { limit } })).status,
  ).toBe(429)
  expect(limit).toHaveBeenCalledTimes(2)
  expect(fetch).not.toHaveBeenCalled()
  fetch.mockRejectedValue(new Error('secret upstream credential'))
  const result = await gateway.fetch(request(chain), enabled)
  expect(result.status).toBe(502)
  expect(await result.text()).not.toContain('secret')
  fetch.mockResolvedValue(
    new Response(null, { status: 302, headers: { Location: 'https://untrusted.example' } }),
  )
  const redirected = await gateway.fetch(request(chain), enabled)
  expect(redirected.status).toBe(502)
  expect(redirected.headers.get('Location')).toBeNull()
})

it.each([401, 429, 500])('does not expose upstream HTTP %s diagnostics or replay an execution request', async (status) => {
  const cancel = vi.fn()
  const upstream = vi.fn(async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('Provider failure at https://trusted-rpc.example with Bearer server-only-test-token'))
      controller.close()
    }, cancel,
  }), { status, headers: { 'Content-Type': 'text/plain' } }))
  vi.stubGlobal('fetch', upstream)
  const result = await gateway.fetch(request({ ...chain, method: 'eth_sendRawTransaction', params: ['0x1234'] }), enabled)
  expect(result.status).toBe(status)
  expect(await result.text()).not.toMatch(/trusted-rpc|server-only-test-token|Bearer/)
  expect(upstream).toHaveBeenCalledOnce()
  expect(cancel).toHaveBeenCalledOnce()
})

it('preserves successful JSON-RPC revert data and request IDs', async () => {
  const body = { jsonrpc: '2.0', id: 'wallet-request', error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } }
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
  const result = await gateway.fetch(request({ ...chain, id: 'wallet-request', method: 'eth_call', params: [{ to: RAILGUN_PROXY }, 'latest'] }), enabled)
  expect(result.status).toBe(200)
  expect(await result.json()).toEqual(body)
})

it('pins each network RPC and rejects unconfigured chains and foreign Railgun log filters', async () => {
  const upstream = vi.fn().mockResolvedValue(Response.json({ jsonrpc: '2.0', id: 1, result: '0x38' }))
  vi.stubGlobal('fetch', upstream)
  const env = { ...enabled, RAILGUN_BNB_RPC_URL: 'https://bnb-rpc.example', RAILGUN_BNB_RPC_TOKEN: 'test-bnb-token' }
  const make = (path: string, body: unknown) => new Request(`https://private.ophis.fi${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  expect((await gateway.fetch(make('/rpc/56', chain), env)).status).toBe(200)
  expect(String(upstream.mock.calls[0][0])).toBe('https://bnb-rpc.example/')
  expect(upstream.mock.calls[0][1].headers.Authorization).toBe('Bearer test-bnb-token')
  upstream.mockClear()
  expect((await gateway.fetch(make('/rpc/137', chain), env)).status).toBe(404)
  expect((await gateway.fetch(make('/rpc/8453', chain), env)).status).toBe(404)
  expect((await gateway.fetch(make('/rpc/84532', chain), env)).status).toBe(404)
  const logs = { ...chain, method: 'eth_getLogs', params: [{ address: RAILGUN_PROXY, fromBlock: '0x0', toBlock: '0x1' }] }
  expect((await gateway.fetch(make('/rpc/56', logs), env)).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  expect(rpcCall({ ...logs, params: [{ ...logs.params[0], address: RAILGUN_PROXIES[56] }] }, RAILGUN_PROXIES[56]).method).toBe('eth_getLogs')
})

it.each([137, 8453].flatMap(chainId => ['eth_chainId', 'eth_call', 'eth_getLogs', 'debug_traceCall', 'eth_sendRawTransaction']
  .map(method => ({ chainId, method }))))('refuses disabled chain $chainId method $method before any quota, meter or upstream work', async ({ chainId, method }) => {
  const upstream = vi.fn(), limit = vi.fn().mockResolvedValue({ success: true }), reserve = vi.fn()
  const env = { ...enabled, VALIDATION_CLOUD_BUDGET: budgetBinding(reserve), RPC_LIMIT: { limit }, TRACE_LIMIT: { limit },
    RAILGUN_POLYGON_RPC_URL: 'https://polygon-mainnet.g.alchemy.com/v2/retained-key',
    RAILGUN_POLYGON_VALIDATION_CLOUD_URL: 'https://mainnet.polygon.validationcloud.io/v1/retained-key',
    RAILGUN_BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/retained-key',
    RAILGUN_BASE_ALCHEMY_EXTENDED: 'true', RAILGUN_ZAN_API_KEY: 'retained-key' }
  vi.stubGlobal('fetch', upstream)
  const params = method === 'eth_call' ? [{ to: RAILGUN_PROXIES[chainId] }, 'latest']
    : method === 'eth_getLogs' ? [{ address: RAILGUN_PROXIES[chainId], fromBlock: '0x1', toBlock: '0x2' }]
    : method === 'debug_traceCall' ? [{ gas: '0x186a0' }, 'latest', { tracer: 'callTracer' }]
    : method === 'eth_sendRawTransaction' ? ['0x1234'] : []
  const response = await gateway.fetch(new Request(`https://swap.ophis.fi/rpc/${chainId}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...chain, method, params }),
  }), env)
  expect(response.status).toBe(404)
  expect(await response.json()).toEqual({ error: 'Unsupported private network.' })
  expect(limit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled()
  expect(env.VALIDATION_CLOUD_BUDGET.getByName).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled()
})

it.each(['', '/manifest', `/page/${'ab'.repeat(32)}/0`, `/tail/${'ab'.repeat(32)}`])(
  'refuses disabled Base history %s even with retained credentials and extended mode', async suffix => {
    const upstream = vi.fn(), limit = vi.fn().mockResolvedValue({ success: true }), reserve = vi.fn()
    const env = { ...enabled, VALIDATION_CLOUD_BUDGET: budgetBinding(reserve), RPC_LIMIT: { limit },
      RAILGUN_BASE_RPC_URL: 'https://base-mainnet.g.alchemy.com/v2/retained-key', RAILGUN_BASE_ALCHEMY_EXTENDED: 'true' }
    vi.stubGlobal('fetch', upstream)
    const response = await gateway.fetch(new Request(`https://swap.ophis.fi/rpc/history/base${suffix}`), env)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Unsupported private network.' })
    expect(limit).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled()
    expect(env.VALIDATION_CLOUD_BUDGET.getByName).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled()
  },
)

it.each([['/rpc', 1], ['/rpc/1', 1], ['/rpc/56', 56], ['/rpc/42161', 42161]] as const)(
  'keeps active route %s on its configured upstream', async (path, chainId) => {
    const upstream = vi.fn().mockResolvedValue(Response.json({ ...chain, result: `0x${chainId.toString(16)}` }))
    vi.stubGlobal('fetch', upstream)
    const env = { ...enabled, RAILGUN_ARBITRUM_RPC_URL: 'https://arbitrum-rpc.example', RAILGUN_ARBITRUM_RPC_TOKEN: 'test-arbitrum-token',
      RAILGUN_BNB_RPC_URL: 'https://bnb-rpc.example', RAILGUN_BNB_RPC_TOKEN: 'test-bnb-token' }
    const response = await gateway.fetch(new Request(`https://swap.ophis.fi${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chain),
    }), env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 1, result: `0x${chainId.toString(16)}` })
    expect(upstream).toHaveBeenCalledExactlyOnceWith(chainId === 1 ? 'https://trusted-rpc.example/'
      : chainId === 56 ? 'https://bnb-rpc.example/' : 'https://arbitrum-rpc.example/', expect.anything())
  },
)
