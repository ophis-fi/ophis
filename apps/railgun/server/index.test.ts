import { afterEach, expect, it, vi } from 'vitest'
import gateway, { rpcCall } from './index'
import { FetchRequest, JsonRpcProvider } from 'ethers'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { RPC_BATCH_SIZE, RAILGUN_PROXY, RAILGUN_PROXIES, isValidationCloudUrl, zanRpcUrl } from '../rpc-policy'

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

it.each([[42161, 'ARBITRUM'], [137, 'POLYGON'], [56, 'BNB']] as const)(
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
    new Response('{"result":{"type":"CALL"}}', {
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
  expect((await gateway.fetch(make('/rpc/137', chain), env)).status).toBe(503)
  expect((await gateway.fetch(make('/rpc/8453', chain), env)).status).toBe(404)
  const logs = { ...chain, method: 'eth_getLogs', params: [{ address: RAILGUN_PROXY, fromBlock: '0x0', toBlock: '0x1' }] }
  expect((await gateway.fetch(make('/rpc/56', logs), env)).status).toBe(400)
  expect(upstream).not.toHaveBeenCalled()
  expect(rpcCall({ ...logs, params: [{ ...logs.params[0], address: RAILGUN_PROXIES[56] }] }, RAILGUN_PROXIES[56]).method).toBe('eth_getLogs')
})
