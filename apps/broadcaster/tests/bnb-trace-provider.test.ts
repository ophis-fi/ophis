import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { BNBTraceProvider, traceRpcURL } from '../src/bnb-trace-provider'

const hash = `0x${'11'.repeat(32)}`, blockHash = `0x${'22'.repeat(32)}`, otherHash = `0x${'33'.repeat(32)}`
const from = '0x0000000000000000000000000000000000000001', to = '0x0000000000000000000000000000000000000002'
const call = { from, to, data: '0x1234', value: '0x1' }
const traceOptions = { tracer: 'callTracer', timeout: '10s' }
const trace = () => ({ type: 'CALL', from, to, input: call.data, value: call.value, calls: [] })
const receipt = () => ({ transactionHash: hash, blockHash, blockNumber: '0x64', status: '0x1', from, to,
  gasUsed: '0x5208', cumulativeGasUsed: '0xa410', effectiveGasPrice: '0x1', transactionIndex: '0x0' })
interface Side { chain: unknown; block: unknown; receipt: unknown; methods: string[]; failHeader?: boolean }
const servers: Server[] = [], providers: BNBTraceProvider[] = []
afterEach(async () => {
  providers.splice(0).forEach((provider) => provider.destroy())
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve())
  })))
  vi.unstubAllEnvs(); vi.resetModules()
})
async function fixture() {
  const side = (): Side => ({ chain: '0x38', block: { number: '0x64', hash: blockHash }, receipt: receipt(), methods: [] })
  const primary = side(), secondary = side()
  let traced: () => unknown | Promise<unknown> = trace
  async function rpc(state: Side) {
    const server = createServer(async (request, response) => {
      let body = ''; for await (const data of request) body += String(data)
      const { method, params, id } = JSON.parse(body) as { method: string; params: unknown[]; id: number }
      state.methods.push(method)
      try {
        let result: unknown
        if (method === 'eth_chainId') result = state.chain
        else if (method === 'eth_getBlockByNumber') {
          if (state.failHeader) throw new Error('Historical headers unsupported')
          result = state.block
        } else if (method === 'eth_getTransactionReceipt') result = state.receipt
        else if (method.startsWith('debug_trace')) result = await traced()
        else result = { source: state === primary ? 'primary' : 'secondary', method, params }
        response.end(JSON.stringify({ jsonrpc: '2.0', id, result }))
      } catch (error) { response.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error) } })) }
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }
  const [a, b] = await Promise.all([rpc(primary), rpc(secondary)])
  const provider = new BNBTraceProvider(a, b, 'fork'); providers.push(provider)
  return { provider, primary, secondary, onTrace: (fn: typeof traced) => { traced = fn },
    call: (params: unknown[] = [call, '0x64', traceOptions]) => provider.send('debug_traceCall', params),
    transaction: () => provider.send('debug_traceTransaction', [hash, { ...traceOptions,
      tracerConfig: { onlyTopCall: false, withLog: false } }]) }
}

it('keeps every nontrace method on the original provider, including the existing submission behavior', async () => {
  const f = await fixture()
  for (const method of ['eth_call', 'eth_getCode', 'eth_getBalance', 'eth_sendRawTransaction', 'custom_method'])
    expect(await f.provider.send(method, ['0x1234'])).toMatchObject({ source: 'primary', method })
  expect(f.secondary.methods).toEqual([])
  expect(await f.call()).toEqual(trace())
  expect(f.secondary.methods.filter((method) => method.startsWith('debug_'))).toEqual(['debug_traceCall'])
  expect(f.primary.methods.some((method) => method.startsWith('debug_'))).toBe(false)
})

it('binds an old transaction using both receipts and primary headers without requesting unsupported secondary headers', async () => {
  const f = await fixture(); f.secondary.failHeader = true
  expect(await f.transaction()).toEqual(trace())
  expect(f.secondary.methods.filter((method) => method === 'eth_getTransactionReceipt')).toHaveLength(2)
  expect(f.secondary.methods).not.toContain('eth_getBlockByNumber')
  expect(f.primary.methods.filter((method) => method === 'eth_getBlockByNumber')).toHaveLength(2)
})

it.each(['latest', 'pending', 'safe', 'finalized', '0x064', undefined, 100])('rejects an implicit or invalid trace block %s', async (tag) => {
  const f = await fixture()
  await expect(f.call([call, tag, traceOptions])).rejects.toThrow('Bound BNB trace')
  expect(f.secondary.methods).toEqual([])
})

it.each([
  { ...traceOptions, stateOverrides: {} }, { ...traceOptions, blockOverrides: {} },
  { ...traceOptions, timeout: '60s' }, { ...traceOptions, tracer: 'prestateTracer' },
  { ...traceOptions, tracerConfig: { onlyTopCall: true } }, { ...traceOptions, tracerConfig: { withLog: true } },
  { ...traceOptions, tracerConfig: { unknown: false } }, { tracer: 'callTracer' },
])('rejects unsupported trace options %j before using either RPC', async (options) => {
  const f = await fixture()
  await expect(f.call([call, '0x64', options])).rejects.toThrow('Bound BNB trace')
  expect(f.secondary.methods).toEqual([])
})

it.each(['primary', 'secondary'] as const)('checks fresh %s chain identity before every trace', async (side) => {
  const f = await fixture(); await f.call(); f[side].chain = '0x1'
  await expect(f.call()).rejects.toThrow('Bound BNB trace')
  expect(f.secondary.methods.filter((method) => method === 'debug_traceCall')).toHaveLength(1)
})

it.each(['primary', 'secondary'] as const)('rejects a %s chain change during the trace', async (side) => {
  const f = await fixture(); f.onTrace(() => { f[side].chain = '0x1'; return trace() })
  await expect(f.call()).rejects.toThrow('Bound BNB trace')
})

it.each([null, { number: '0x64', hash: otherHash }, { number: '0x65', hash: blockHash }])('rejects missing or mismatched call block %j', async (block) => {
  const f = await fixture(); f.secondary.block = block
  await expect(f.call()).rejects.toThrow('Bound BNB trace')
  expect(f.secondary.methods).not.toContain('debug_traceCall')
})

it('rejects a canonical call reorganization even when both endpoints move together', async () => {
  const f = await fixture(); f.onTrace(() => {
    f.primary.block = f.secondary.block = { number: '0x64', hash: otherHash }; return trace()
  })
  await expect(f.call()).rejects.toThrow('Bound BNB trace')
})

it.each([
  null, { ...receipt(), transactionHash: otherHash }, { ...receipt(), blockHash: otherHash },
  { ...receipt(), blockNumber: '0x65' }, { ...receipt(), status: '0x0' }, { ...receipt(), from: to },
  { ...receipt(), to: from }, { ...receipt(), gasUsed: '0x5209' }, { ...receipt(), cumulativeGasUsed: '0xa411' },
  { ...receipt(), effectiveGasPrice: '0x2' }, { ...receipt(), transactionIndex: '0x1' },
])('rejects missing or mismatched transaction receipt %j', async (value) => {
  const f = await fixture(); f.secondary.receipt = value
  await expect(f.transaction()).rejects.toThrow('Bound BNB trace')
  expect(f.secondary.methods).not.toContain('debug_traceTransaction')
})

it('rejects receipts whose shared block is no longer canonical at the primary', async () => {
  const f = await fixture(); f.primary.block = { number: '0x64', hash: otherHash }
  await expect(f.transaction()).rejects.toThrow('Bound BNB trace')
})

it.each(['receipt', 'block'] as const)('rejects transaction evidence changed during trace (%s)', async (change) => {
  const f = await fixture(); f.onTrace(() => {
    if (change === 'receipt') f.primary.receipt = f.secondary.receipt = { ...receipt(), gasUsed: '0x5209' }
    else { f.primary.receipt = f.secondary.receipt = { ...receipt(), blockHash: otherHash }; f.primary.block = { number: '0x64', hash: otherHash } }
    return trace()
  })
  await expect(f.transaction()).rejects.toThrow('Bound BNB trace')
})

it.each([null, [], { ...trace(), type: 'CREATE' }, { ...trace(), from: to }, { ...trace(), to: from },
  { ...trace(), input: '0xabcd' }, { ...trace(), value: '0x0' }])('rejects unavailable or unrelated call trace %j', async (result) => {
  const f = await fixture(); f.onTrace(() => result)
  await expect(f.call()).rejects.toThrow('Bound BNB trace')
})

it('pins the requested block and transaction across asynchronous caller mutation', async () => {
  const f = await fixture(), transaction = { ...call }, params = [transaction, '0x64', traceOptions]
  const pending = f.call(params); transaction.to = from; params[1] = '0x65'
  expect(await pending).toEqual(trace())
})

it('never falls back to primary tracing or leaks provider error details', async () => {
  const f = await fixture(); f.onTrace(() => { throw new Error('https://secret.invalid/private-key-in-url') })
  await expect(f.transaction()).rejects.toThrow(/^Bound BNB trace unavailable or canonical evidence changed\.$/)
  expect(f.primary.methods).not.toContain('debug_traceTransaction')
})

it('bounds an unresponsive secondary request and does not retry it through the primary', async () => {
  const f = await fixture(); f.onTrace(() => new Promise(() => {}))
  await expect(f.transaction()).rejects.toThrow('Bound BNB trace')
  expect(f.primary.methods).not.toContain('debug_traceTransaction')
}, 15_000)

it('destroys the secondary together with the primary', async () => {
  const f = await fixture(); f.provider.destroy()
  expect(f.provider.destroyed).toBe(true)
  expect((f.provider as unknown as { traceProvider: { destroyed: boolean } }).traceProvider.destroyed).toBe(true)
})

it('keeps the optional URL disabled unless explicitly configured for BNB', () => {
  expect(traceRpcURL(undefined, 1, 'mainnet')).toBeUndefined()
  expect(traceRpcURL('https://trace.example/', 56, 'mainnet')).toBe('https://trace.example/')
  expect(traceRpcURL('http://127.0.0.1:1234', 56, 'fork')).toBe('http://127.0.0.1:1234/')
  for (const [value, chain, mode] of [
    ['https://trace.example', 1, 'mainnet'], ['https://trace.example', 42161, 'mainnet'],
    ['https://trace.example', 137, 'mainnet'], ['http://trace.example', 56, 'mainnet'],
    ['https://127.0.0.1:1234', 56, 'mainnet'], ['https://user:secret@trace.example', 56, 'mainnet'],
    ['https://trace.example/#secret', 56, 'mainnet'], ['https://trace.example', 56, 'fork'],
    ['http://localhost:1234', 56, 'fork'], ['', 56, 'mainnet'],
  ] as const) expect(() => traceRpcURL(value, chain, mode)).toThrow(/^The optional BNB trace RPC requires/)
})

it.each([1, 56, 42161, 137])('integrates optional trace routing only into chain%i configuration', async (chainId) => {
  vi.stubEnv('OPHIS_BROADCASTER_CHAIN_ID', String(chainId))
  const { settings } = await import('../src/config')
  const env = { OPHIS_BROADCASTER_CHAIN_ID: String(chainId), OPHIS_BROADCASTER_RPC: 'https://state.example/' }
  expect(settings(env).traceRpc).toBeUndefined()
  const configured = { ...env, OPHIS_BROADCASTER_TRACE_RPC: 'https://trace.example/' }
  if (chainId === 56) expect(settings(configured).traceRpc).toBe(configured.OPHIS_BROADCASTER_TRACE_RPC)
  else expect(() => settings(configured)).toThrow('optional BNB trace RPC')
})
