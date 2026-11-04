import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getAddress, Transaction } from 'ethers'
import { NETWORK } from '../src/config'
import { ProtectedEthereumProvider, PROTECTED_WRITE_RPC } from '../../railgun/operator/protected-provider'

/** Exercises the real protected sender; all signed writes remain on the verified test fork. */
export async function forkProtectedSender(forkURL: string, operator: string, guard: string, directory: string) {
  assert.equal(new URL(forkURL).hostname, '127.0.0.1')
  const originalFetch = globalThis.fetch
  let writes = 0, leakedWrite = false, closed = false
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
      if (String(call.method).startsWith('eth_send')) {
        leakedWrite = true
        throw new Error('Signed write reached the read connection.')
      }
      const result = await originalFetch(forkURL, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } })
      response.end(await result.text())
    } catch { response.writeHead(500).end('Fork read fixture failed.') }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  let sender: ProtectedEthereumProvider | undefined
  const close = async () => {
    // Keep late asynchronous private writes blocked until this standalone fixture process exits.
    closed = true
    try { sender?.destroy() } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
  try {
    const transport = new ProtectedEthereumProvider(`http://127.0.0.1:${address.port}`, operator, directory, guard)
    sender = transport
    globalThis.fetch = async (endpoint, options) => {
      if (endpoint !== PROTECTED_WRITE_RPC) return originalFetch(endpoint, options)
      if (closed) throw new Error('The fork protected sender is closed.')
      const call = JSON.parse(String(options?.body))
      assert.equal(call.method, 'eth_sendRawTransaction')
      const tx = Transaction.from(call.params[0])
      assert.equal(tx.from, operator)
      if (tx.type === 4) assert.equal(tx.to, guard)
      else { assert.equal(tx.type, 1); assert.equal(tx.to, getAddress(NETWORK.proxyContract)) }
      assert.equal(transport.pendingTransaction()?.hash, tx.hash, 'Protected journal must precede disclosure.')
      writes++
      return originalFetch(forkURL, options)
    }
    return { sender: transport, stats: () => ({ protectedWrites: writes, leakedWrite }), close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Fork transport startup failed.') }
    throw error
  }
}
