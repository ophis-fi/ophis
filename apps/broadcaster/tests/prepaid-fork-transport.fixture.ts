import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getAddress, keccak256, toUtf8Bytes, Transaction } from 'ethers'
import { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { protectedWriteRPC, readBnbBundle } from '../../railgun/operator/protected-submission'

interface Pins {
  rpc: string; chainId: number; operator: string; guard: string; proxy: string
  assertOwned: () => Promise<void>; pendingHash: () => string | undefined
}

// Exported only so the network boundary can be tested without a fork or SDK scan.
export function prepaidForkFetch(pins: Pins, fetchLocal: typeof fetch, closed: () => boolean,
  written: (envelope?: { maxBlockNumber: number; maxTimestamp: number }) => void): typeof fetch {
  assert.equal(new URL(pins.rpc).hostname, '127.0.0.1')
  assert([1, 56].includes(pins.chainId))
  return async (endpoint, options) => {
    const url = endpoint instanceof Request ? endpoint.url : String(endpoint)
    if (![protectedWriteRPC(1), protectedWriteRPC(56)].includes(url)) {
      // Public SDK indexer/artifact reads are allowed; no unrelated RPC write is.
      let call: { method?: unknown } | undefined
      try { call = JSON.parse(String(options?.body)) } catch { /* Not a JSON RPC body. */ }
      assert(!/^(eth_send|eth_sign|personal_|anvil_|evm_)/.test(String(call?.method)), 'Unexpected RPC write outside the isolated relay redirect.')
      return fetchLocal(endpoint, options)
    }
    assert(!closed(), 'The isolated protected sender is closed.')
    assert.equal(url, protectedWriteRPC(pins.chainId), 'Protected endpoint differs from the selected fork chain.')
    assert.equal(options?.method, 'POST')
    const body = String(options?.body), call = JSON.parse(body)
    const envelope = pins.chainId === 56 ? readBnbBundle(body) : undefined
    if (!envelope) {
      assert.equal(call.jsonrpc, '2.0'); assert.equal(call.id, 1)
      assert.equal(call.method, 'eth_sendRawTransaction'); assert.equal(call.params.length, 1)
    }
    const raw = envelope?.raw ?? call.params[0], tx = Transaction.from(raw)
    assert.equal(tx.chainId, BigInt(pins.chainId)); assert.equal(tx.from, getAddress(pins.operator))
    assert.equal(tx.to, getAddress(tx.type === 4 ? pins.guard : pins.proxy))
    assert.equal(pins.pendingHash(), tx.hash, 'The protected journal must precede disclosure.')
    await pins.assertOwned()
    const response = await fetchLocal(pins.rpc, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, signal: options?.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const result = await response.json() as { result?: unknown; error?: unknown }
    assert(response.ok && !result.error && result.result === tx.hash, 'Owned fork did not acknowledge the exact signed transaction.')
    written(envelope && { maxBlockNumber: envelope.maxBlockNumber, maxTimestamp: envelope.maxTimestamp })
    // A synthetic builder acknowledgment is distinct from the actual transaction hash.
    return Response.json({ jsonrpc: '2.0', id: 1, result: envelope ? keccak256(toUtf8Bytes(body)) : tx.hash })
  }
}

/** Real protected sender, with its fixed write endpoint intercepted before network I/O. */
export async function forkPrepaidSender(pins: Omit<Pins, 'pendingHash'>, directory: string) {
  const originalFetch = globalThis.fetch
  let writes = 0, leakedWrite = false, closed = false
  const bundles: { maxBlockNumber: number; maxTimestamp: number }[] = []
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) { body += chunk; assert(body.length <= 1024 * 1024) }
      const call = JSON.parse(body)
      response.setHeader('Content-Type', 'application/json')
      if (['anvil_metadata', 'hardhat_metadata'].includes(call.method)) {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32601, message: 'Method not found' } }))
        return
      }
      if (!/^(eth_(chainId|blockNumber|get\w+|call|estimateGas|gasPrice|maxPriorityFeePerGas|feeHistory)|net_version|web3_clientVersion)$/.test(String(call.method))) {
        leakedWrite = true
        throw new Error('Unexpected request reached the isolated read connection.')
      }
      const result = await originalFetch(pins.rpc, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
      response.end(await result.text())
    } catch { response.writeHead(500).end('Isolated read fixture failed.') }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  let sender: ProtectedEthereumProvider | undefined
  const close = async () => {
    closed = true // Keep late protected writes blocked until this standalone process exits.
    try { sender?.destroy() } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
  }
  try {
    sender = new ProtectedEthereumProvider(`http://127.0.0.1:${address.port}`, pins.operator, directory, pins.guard, pins.chainId)
    globalThis.fetch = prepaidForkFetch({ ...pins, pendingHash: () => sender!.pendingTransaction()?.hash }, originalFetch,
      () => closed, (bundle) => { writes++; if (bundle) bundles.push(bundle) })
    return { sender, stats: () => ({ protectedWrites: writes, leakedWrite, bundles, liveBuilder: false }), close }
  } catch (error) { await close(); throw error }
}
