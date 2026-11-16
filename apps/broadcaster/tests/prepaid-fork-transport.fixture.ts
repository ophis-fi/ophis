import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { getAddress, keccak256, toUtf8Bytes, Transaction } from 'ethers'
import { ProtectedEthereumProvider } from '../../railgun/operator/protected-provider'
import { protectedWriteRPC, readBnbBundle } from '../../railgun/operator/protected-submission'
import { readBaseValidityBody } from '../../railgun/operator/base-validity'

interface Pins {
  rpc: string; chainId: number; operator: string; guard: string; proxy: string
  assertOwned: () => Promise<void>; pendingHash: () => string | undefined
}

const forkAlchemyRPC = 'https://arb-mainnet.g.alchemy.com/v2/fork-test-key'
export const forkWriteRPC = (chainId: number): string => protectedWriteRPC(chainId, chainId === 42161 ? forkAlchemyRPC : undefined)

// Synthetic fixture diagnostics only: never retain transaction bytes, URLs or
// arbitrary SDK error fields when the production backend sanitizes its response.
export function forkSenderDiagnostic(error: unknown): { code?: string; message: string }[] {
  const records: { code?: string; message: string }[] = []
  const safe = (value: string) => value.replace(/https?:\/\/\S+/g, '[url]')
    .replace(/0x[0-9a-f]{40,}/gi, '[hex]').slice(0, 400)
  for (let current = error; current && records.length < 3;) {
    if (typeof current !== 'object') { records.push({ message: 'Non-object fixture exception.' }); break }
    const item = current as { code?: unknown; shortMessage?: unknown; message?: unknown; cause?: unknown }
    const message = typeof item.shortMessage === 'string' ? item.shortMessage : typeof item.message === 'string' ? item.message : 'Unknown fixture exception.'
    const code = typeof item.code === 'number' ? String(item.code) : typeof item.code === 'string' && /^[A-Z_0-9-]{1,40}$/.test(item.code) ? item.code : undefined
    records.push({ ...(code === undefined ? {} : { code }), message: safe(message) })
    current = item.cause
  }
  return records
}

// Exported only so the network boundary can be tested without a fork or SDK scan.
export function prepaidForkFetch(pins: Pins, fetchLocal: typeof fetch, closed: () => boolean,
  written: (envelope?: { maxBlockNumber: number; maxTimestamp: number }) => void): typeof fetch {
  assert.equal(new URL(pins.rpc).hostname, '127.0.0.1')
  assert([1, 56, 42161, 8453].includes(pins.chainId))
  return async (endpoint, options) => {
    const url = endpoint instanceof Request ? endpoint.url : String(endpoint)
    if (![1, 56, 42161, 8453].map(forkWriteRPC).includes(url)) {
      // Public SDK indexer/artifact reads are allowed; no unrelated RPC write is.
      let call: { method?: unknown } | undefined
      try { call = JSON.parse(String(options?.body)) } catch { /* Not a JSON RPC body. */ }
      assert(!/^(eth_send|eth_sign|personal_|anvil_|evm_)/.test(String(call?.method)), 'Unexpected RPC write outside the isolated relay redirect.')
      return fetchLocal(endpoint, options)
    }
    assert(!closed(), 'The isolated protected sender is closed.')
    assert.equal(url, forkWriteRPC(pins.chainId), 'Protected endpoint differs from the selected fork chain.')
    assert.equal(options?.method, 'POST')
    const body = String(options?.body), call = JSON.parse(body)
    const envelope = pins.chainId === 56 ? readBnbBundle(body) : undefined
    const base = pins.chainId === 8453 ? readBaseValidityBody(body) : undefined
    if (!envelope && !base) {
      assert.equal(call.jsonrpc, '2.0'); assert.equal(call.id, 1)
      assert.equal(call.method, 'eth_sendRawTransaction'); assert.equal(call.params.length, 1)
    }
    const raw = envelope?.raw ?? base?.raw ?? call.params[0], tx = Transaction.from(raw)
    assert.equal(tx.chainId, BigInt(pins.chainId)); assert.equal(tx.from, getAddress(pins.operator))
    assert.equal(tx.to, getAddress(tx.type === 4 || base ? pins.guard : pins.proxy))
    assert.equal(pins.pendingHash(), tx.hash, 'The protected journal must precede disclosure.')
    await pins.assertOwned()
    if (base) {
      // Anvil has no conditional sequencer. Check the real canonical envelope's
      // predicates against this owned node before forwarding its exact bytes.
      const read = async (method: string, params: unknown[]) => {
        const response = await fetchLocal(pins.rpc, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
        const result = await response.json() as { result?: string; error?: unknown }
        assert(response.ok && !result.error && typeof result.result === 'string', 'Owned Base predicate read failed.')
        return result.result
      }
      const head = await read('eth_blockNumber', [])
      assert(BigInt(head) <= BigInt(base.expiryBlock), 'Owned Base validity envelope expired.')
      for (const predicate of call.params[1].validity.slice(0, 7)) {
        const { address, slot, value, mask, op } = predicate.params
        const actual = BigInt(await read('eth_getStorageAt', [address, slot, head]))
        const masked = mask === undefined ? actual : actual & BigInt(mask)
        assert(op === '=' ? masked === BigInt(value) : op === '<=' && masked <= BigInt(value), 'Owned Base fee predicate changed.')
      }
    }
    const response = await fetchLocal(pins.rpc, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, signal: options?.signal,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }) })
    const result = await response.json() as { result?: unknown; error?: unknown }
    if (!response.ok || result.error || result.result !== tx.hash)
      throw new Error('Owned fork did not acknowledge the exact signed transaction.', { cause: result.error })
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
    sender = new ProtectedEthereumProvider(`http://127.0.0.1:${address.port}`, pins.operator, directory, pins.guard, pins.chainId,
      [42161, 8453].includes(pins.chainId), pins.chainId === 42161 ? forkAlchemyRPC : undefined)
    globalThis.fetch = prepaidForkFetch({ ...pins, pendingHash: () => sender!.pendingTransaction()?.hash }, originalFetch,
      () => closed, (bundle) => { writes++; if (bundle) bundles.push(bundle) })
    return { sender, stats: () => ({ protectedWrites: writes, leakedWrite, bundles, liveBuilder: false }), close }
  } catch (error) { await close(); throw error }
}
