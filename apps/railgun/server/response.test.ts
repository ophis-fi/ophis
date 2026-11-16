import { expect, it } from 'vitest'
import { AbiCoder, JsonRpcProvider } from 'ethers'
import { publicRpcResponse } from './response'

const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const secret = 'https://arb-mainnet.g.alchemy.com/v2/synthetic-server-key'
async function clean(error: unknown, status = 200) {
  return publicRpcResponse(Response.json({ jsonrpc: '2.0', id: 'wallet-1', error, diagnostic: secret }, { status }), headers)
}

it.each([200, 400, 500])('removes HTTP %s JSON error diagnostics while preserving exact revert data and RPC identity', async status => {
  const data = '0x08c379a0' + AbiCoder.defaultAbiCoder().encode(['string'], ['RailgunSmartWallet: Gas price too low']).slice(2)
  const response = await clean({ code: 3, message: `execution reverted at ${secret}`, data, stack: secret }, status)
  expect(response.status).toBe(status)
  const body = await response.json()
  expect(body).toEqual({ jsonrpc: '2.0', id: 'wallet-1', error: { code: 3, message: 'execution reverted', data } })
  const provider = new JsonRpcProvider(undefined, 42161, { staticNetwork: true })
  const error = provider.getRpcError({ jsonrpc: '2.0', id: 1, method: 'eth_estimateGas', params: [{ to: '0x' + '11'.repeat(20) }] }, body as any)
  expect(error).toMatchObject({ code: 'CALL_EXCEPTION', data, reason: 'RailgunSmartWallet: Gas price too low' })
  provider.destroy()
})

it.each([
  ['eth_estimateGas', 'insufficient funds', 'INSUFFICIENT_FUNDS'],
  ['eth_estimateGas', 'nonce too low', 'NONCE_EXPIRED'],
  ['eth_sendRawTransaction', 'replacement transaction underpriced', 'REPLACEMENT_UNDERPRICED'],
  ['eth_sendRawTransaction', 'only replay-protected transactions allowed', 'UNSUPPORTED_OPERATION'],
])('preserves ethers classification for %s: %s', async (method, message, code) => {
  const response = await clean({ code: -32000, message: `${message}; endpoint ${secret}` })
  const body = await response.json()
  expect(JSON.stringify(body)).not.toContain(secret)
  const provider = new JsonRpcProvider(undefined, 42161, { staticNetwork: true })
  const error = provider.getRpcError({ jsonrpc: '2.0', id: 1, method, params: [{ to: '0x' + '11'.repeat(20) }] }, body as any)
  expect(error).toMatchObject({ code })
  provider.destroy()
})

it('retains nested hex revert data but discards arbitrary error objects and strings', async () => {
  const response = await clean({ code: 3, message: `execution reverted ${secret}`,
    data: { originalError: { data: '0x1234', message: secret }, request: secret } })
  expect(await response.json()).toEqual({ jsonrpc: '2.0', id: 'wallet-1', error: { code: 3, message: 'execution reverted', data: '0x1234' } })
  const invalid = await clean({ code: -32000, message: secret, data: secret })
  expect(await invalid.json()).toEqual({ jsonrpc: '2.0', id: 'wallet-1', error: { code: -32000, message: 'Trusted RPC rejected the request.' } })
})

it('preserves batch successes and error codes without forwarding outer diagnostics', async () => {
  const response = await publicRpcResponse(Response.json([
    { jsonrpc: '2.0', id: 1, result: '0x1234', debug: secret },
    { jsonrpc: '2.0', id: 2, error: { code: -32602, message: secret, data: { debug: secret } } },
  ]), headers)
  expect(await response.json()).toEqual([
    { jsonrpc: '2.0', id: 1, result: '0x1234' },
    { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'invalid RPC parameters' } },
  ])
})

it('rejects oversized responses before parsing and cancels the provider stream', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 ** 2 + 1)) },
    cancel() { cancelled = true },
  })
  const response = await publicRpcResponse(new Response(stream), headers)
  expect(response.status).toBe(502)
  expect(cancelled).toBe(true)
  expect(await response.text()).not.toContain(secret)
})

it('rejects malformed JSON-RPC provider diagnostics without changing a caller into a retry', async () => {
  const response = await publicRpcResponse(Response.json({ message: secret }), headers)
  expect(response.status).toBe(502)
  expect(await response.text()).not.toContain(secret)
})
