import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { decodeRlp, encodeRlp, FetchRequest, Transaction, Wallet } from 'ethers'
import { PROTECTED_WRITE_RPC, ProtectedEthereumProvider } from './protected-provider'
import { EXECUTION_GUARD, executionGuardCode } from './execution-guard'

const config = NETWORK_CONFIG[NetworkName.Ethereum]
const operator = Wallet.createRandom()
const ephemeral = Wallet.createRandom()
let server: Server
let directory: string
let readURL: string
let providers: ProtectedEthereumProvider[]
let reads: { method: string; params: unknown[] }[]
let latest: bigint
let confirmed: bigint
let chain: string
let fork: boolean
let forkError: boolean
let nextBlockRead: (() => Promise<void>) | undefined
let write: ReturnType<typeof vi.fn>
let executionGuard: string | undefined
let guardCode: string | undefined

async function signed(overrides = {}): Promise<string> {
  const auth = await ephemeral.authorize({ address: config.relayAdapt7702Contract, chainId: 1, nonce: 0 })
  return operator.signTransaction({
    type: 4, chainId: 1, nonce: 0, to: ephemeral.address, authorizationList: [auth],
    data: '0x12345678', value: 0n, gasLimit: 1_000_000n,
    maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...overrides,
  })
}

function provider(guard?: string): ProtectedEthereumProvider {
  const request = new FetchRequest(readURL)
  request.setHeader('Authorization', 'private-read-node-credential')
  const result = new ProtectedEthereumProvider(request, operator.address, directory, guard)
  providers.push(result)
  return result
}

function signedCancellation(overrides = {}): Promise<string> {
  return operator.signTransaction({ type: 2, chainId: 1, nonce: 0, to: operator.address,
    value: 0n, data: '0x', gasLimit: 21_000n, maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n, ...overrides })
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-protected-provider-'))
  providers = []; reads = []; latest = 0n; confirmed = 0n; chain = '0x1'; fork = false; forkError = false; nextBlockRead = undefined
  executionGuard = undefined; guardCode = undefined
  server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const call = JSON.parse(body)
    reads.push({ method: call.method, params: call.params })
    if (call.method === 'eth_blockNumber' && nextBlockRead) {
      const pause = nextBlockRead
      nextBlockRead = undefined
      await pause()
    }
    if (forkError && call.method === 'anvil_metadata') {
      res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'Node unavailable' } }))
      return
    }
    let result: unknown
    switch (call.method) {
      case 'eth_chainId': result = chain; break
      case 'eth_blockNumber': result = '0x64'; break
      case 'eth_getTransactionCount': result = `0x${(call.params[1] === 'latest' ? latest : confirmed).toString(16)}`; break
      case 'eth_getBalance': result = '0x1'; break
      case 'eth_getCode': result = call.params[0] === executionGuard ? guardCode : '0x6001'; break
      case 'anvil_metadata': if (fork) result = { forkedNetwork: { chainId: 1 } }; break
    }
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, ...(result === undefined
      ? { error: { code: -32601, message: 'Method not found' } } : { result }) }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local read server.')
  readURL = `http://127.0.0.1:${address.port}`
  write = vi.fn(async (_url: string, options: RequestInit) => {
    const { params } = JSON.parse(options.body as string)
    return Response.json({ jsonrpc: '2.0', id: 1, result: Transaction.from(params[0]).hash })
  })
  // Ethers uses its own HTTP transport for reads. No test can send a transaction outside this process.
  vi.stubGlobal('fetch', write)
})

afterEach(async () => {
  for (const current of providers) current.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

describe('protected operator transport', () => {
  it('can stage a legacy crash-gap original for cancellation without allowing its publication', async () => {
    const current = provider(Wallet.createRandom().address)
    const original = await signed()
    expect(await current.stageSigned(original)).toBe(Transaction.from(original).hash)
    expect(write).not.toHaveBeenCalled()
    await expect(current.retryPending()).rejects.toThrow('guarded private execution')
    expect(current.pendingTransaction()?.hash).toBe(Transaction.from(original).hash)
    const cancelled = await current.cancelPending(await signedCancellation())
    expect(current.pendingTransaction()?.cancellationHash).toBe(cancelled)
    expect(current.pendingTransaction()?.hash).toBe(Transaction.from(original).hash)
    expect(write).toHaveBeenCalledOnce()
  })
  it('pins guarded type-4 publication to the reviewed code and authorization account', async () => {
    executionGuard = Wallet.createRandom().address
    guardCode = executionGuardCode(operator.address, '0x6001')
    const current = provider(executionGuard)
    await expect(current.send('eth_sendRawTransaction', [await signed()])).rejects.toThrow('guarded private execution')
    const data = EXECUTION_GUARD.encodeFunctionData('execute', [ephemeral.address, '0x3e12cc2e', 0n])
    const raw = await signed({ to: executionGuard, data })
    expect(await current.send('eth_sendRawTransaction', [raw])).toBe(Transaction.from(raw).hash)
    expect(write).toHaveBeenCalledOnce()
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
  })
  it('rejects a guard with substituted code before journaling or publication', async () => {
    executionGuard = Wallet.createRandom().address
    guardCode = '0x6002'
    const current = provider(executionGuard)
    const data = EXECUTION_GUARD.encodeFunctionData('execute', [ephemeral.address, '0x3e12cc2e', 0n])
    await expect(current.send('eth_sendRawTransaction', [await signed({ to: executionGuard, data })])).rejects.toThrow('reviewed artifact')
    expect(current.pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })
  it('stages signed bytes without any publication so an interrupted sender can cancel safely', async () => {
    const current = provider()
    const original = await signed()
    expect(await current.stageSigned(original)).toBe(Transaction.from(original).hash)
    expect(write).not.toHaveBeenCalled()
    expect(current.pendingTransaction()?.hash).toBe(Transaction.from(original).hash)
    expect(await current.cancelPending(await signedCancellation())).toMatch(/^0x[0-9a-f]{64}$/)
    expect(write).toHaveBeenCalledTimes(1)
    expect(Transaction.from(JSON.parse(write.mock.calls[0][1].body as string).params[0]).data).toBe('0x')
  })
  it('uses the existing read connection but sends signed type-4 bytes only to hash-only Flashbots', async () => {
    const current = provider()
    expect(await current.getBalance(operator.address)).toBe(1n)
    const raw = await signed()
    const response = await current.broadcastTransaction(raw)
    expect(response.hash).toBe(Transaction.from(raw).hash)
    expect(write).toHaveBeenCalledTimes(1)
    const [url, options] = write.mock.calls[0]
    expect(url).toBe(PROTECTED_WRITE_RPC)
    expect(url).toBe('https://rpc.flashbots.net?hint=hash')
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(options.redirect).toBe('error')
    expect(options.signal).toBeInstanceOf(AbortSignal)
    expect(JSON.parse(options.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] })
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
    expect(reads.filter((call) => call.method === 'eth_getTransactionCount').map((call) => call.params[1])).toEqual(['latest', '0x63'])
    expect(current.pendingTransaction()).toEqual({ hash: response.hash, nonce: 0 })
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, 'protected-transactions.sqlite')).mode & 0o777).toBe(0o600)
  })

  it.each([
    ['rate limit', () => new Response('', { status: 429 })],
    ['server error', () => new Response('', { status: 500 })],
    ['RPC error', () => Response.json({ jsonrpc: '2.0', id: 1, error: { message: 'secret upstream payload' } })],
    ['wrong hash', () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x1234' })],
    ['wrong id', () => Response.json({ jsonrpc: '2.0', id: 2, result: '0x1234' })],
    ['bad JSON', () => new Response('not JSON')],
    ['timeout', () => { throw new DOMException('secret upstream payload', 'TimeoutError') }],
    ['redirect rejection', () => { throw new TypeError('fetch failed') }],
  ])('retains the pending nonce after %s without leaking upstream errors or falling back', async (_label, response) => {
    write.mockImplementationOnce(response)
    const current = provider()
    const raw = await signed()
    await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow('Its outcome is unknown')
    expect(current.pendingTransaction()?.hash).toBe(Transaction.from(raw).hash)
    expect(write).toHaveBeenCalledTimes(1)
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
  })

  it('journals before disclosure, and retries identical bytes after restart instead of reusing the nonce', async () => {
    const raw = await signed()
    const current = provider()
    let journalAtDisclosure: ReturnType<typeof current.pendingTransaction>
    write.mockImplementationOnce(() => {
      journalAtDisclosure = current.pendingTransaction()
      throw new Error('timeout')
    })
    await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow('unknown')
    expect(journalAtDisclosure!).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    current.destroy(); providers = []
    const restarted = provider()
    await expect(restarted.send('eth_sendRawTransaction', [await signed({ nonce: 1 })])).rejects.toThrow('nonce is unresolved')
    await expect(restarted.send('eth_sendRawTransaction', [await signed({ maxFeePerGas: 3_000_000_000n })])).rejects.toThrow('nonce is unresolved')
    expect(write).toHaveBeenCalledTimes(1)
    expect(await restarted.retryPending()).toBe(Transaction.from(raw).hash)
    expect(JSON.parse(write.mock.calls[1][1].body as string).params).toEqual([raw])
  })

  it('unlocks the operator only after its previous nonce has two confirmations', async () => {
    const current = provider()
    await current.send('eth_sendRawTransaction', [await signed()])
    latest = 1n
    await expect(current.send('eth_sendRawTransaction', [await signed({ nonce: 1 })])).rejects.toThrow('nonce is unresolved')
    confirmed = 1n
    const next = await signed({ nonce: 1 })
    expect(await current.send('eth_sendRawTransaction', [next])).toBe(Transaction.from(next).hash)
    expect(current.pendingTransaction()?.nonce).toBe(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('serializes different submissions across provider instances sharing the same journal', async () => {
    const first = provider(), second = provider()
    const outcomes = await Promise.allSettled([
      first.send('eth_sendRawTransaction', [await signed()]),
      second.send('eth_sendRawTransaction', [await signed({ maxFeePerGas: 3_000_000_000n })]),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('rejects a wrong chain, sender, delegate, authority, target, fee, nonce and unsigned input before disclosure', async () => {
    const current = provider()
    const wrongAuth = await ephemeral.authorize({ address: Wallet.createRandom().address, chainId: 1, nonce: 0 })
    const crossChainAuth = await ephemeral.authorize({ address: config.relayAdapt7702Contract, chainId: 0, nonce: 0 })
    const selfAuth = await operator.authorize({ address: config.relayAdapt7702Contract, chainId: 1, nonce: 1 })
    const samples = [
      'not a transaction',
      Transaction.from({ to: config.proxyContract, data: '0x1234', chainId: 1 }).unsignedSerialized,
      await signed({ chainId: 56 }), await signed({ authorizationList: [wrongAuth] }),
      await signed({ authorizationList: [crossChainAuth] }), await signed({ to: operator.address }),
      await signed({ to: operator.address, authorizationList: [selfAuth] }),
      await signed({ authorizationList: [] }), await signed({ nonce: 5 }),
      await signed({ maxPriorityFeePerGas: 0n }), await signed({ gasLimit: 30_000_001n }),
      await signed({ value: 1n }), await signed({ data: '0x' }),
      await signed({ type: 2, authorizationList: [], to: ephemeral.address }),
      await Wallet.createRandom().signTransaction({ chainId: 1, to: config.proxyContract, data: '0x1234', gasLimit: 100_000n, gasPrice: 1n, type: 0 }),
    ]
    for (const raw of samples) await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(current.pendingTransaction()).toBeUndefined()
    await expect(current.send('eth_sendTransaction', [{ from: operator.address }])).rejects.toThrow('reads and protected')
    await expect(current.send('eth_sign', [operator.address, '0x1234'])).rejects.toThrow('reads and protected')
    await expect(current._send([
      { jsonrpc: '2.0', id: 4, method: 'eth_chainId', params: [] },
      { jsonrpc: '2.0', id: 5, method: 'eth_sendRawTransaction', params: [await signed()] },
    ])).rejects.toThrow('reads and protected')
  })

  it.each(['wrong chain', 'local fork'])('rejects %s on the read node before writing', async (kind) => {
    if (kind === 'wrong chain') chain = '0x89'
    else fork = true
    await expect(provider().send('eth_sendRawTransaction', [await signed()])).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
  })

  it('also protects ordinary withdrawals to the canonical proxy', async () => {
    const raw = await operator.signTransaction({ type: 1, chainId: 1, nonce: 0,
      to: config.proxyContract, data: '0x12345678', gasLimit: 200_000n, gasPrice: 2_000_000_000n })
    expect(await provider().send('eth_sendRawTransaction', [raw])).toBe(Transaction.from(raw).hash)
  })

  it('refuses a journal in a publicly readable directory', () => {
    chmodSync(directory, 0o755)
    expect(() => provider()).toThrow('private directory')
  })

  it('refuses a publicly readable journal file', () => {
    const path = join(directory, 'protected-transactions.sqlite')
    writeFileSync(path, '', { mode: 0o644 })
    expect(() => provider()).toThrow('private file')
  })

  it('fails closed when the read node cannot check fork state', async () => {
    forkError = true
    await expect(provider().send('eth_sendRawTransaction', [await signed()])).rejects.toThrow('could not verify')
    expect(write).not.toHaveBeenCalled()
  })

  it('rejects inconsistent nonce state without discarding the pending record', async () => {
    const current = provider()
    await current.send('eth_sendRawTransaction', [await signed()])
    confirmed = 1n
    await expect(current.send('eth_sendRawTransaction', [await signed({ nonce: 1 })])).rejects.toThrow('inconsistent nonce')
    expect(current.pendingTransaction()?.nonce).toBe(0)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('rejects noncanonical raw encodings before journaling or sending them', async () => {
    const raw = await signed()
    const fields = decodeRlp(`0x${raw.slice(4)}`)
    if (!Array.isArray(fields)) throw new Error('Expected type-4 fields.')
    fields[1] = '0x00'
    const noncanonical = `0x04${encodeRlp(fields).slice(2)}`
    const current = provider()
    await expect(current.send('eth_sendRawTransaction', [noncanonical])).rejects.toThrow('Canonical transaction encoding')
    expect(write).not.toHaveBeenCalled()
    expect(current.pendingTransaction()).toBeUndefined()
  })

  it('privately cancels the journaled nonce, preserves the original hash and retries the cancellation after restart', async () => {
    const current = provider()
    const original = await signed()
    await current.send('eth_sendRawTransaction', [original])
    const cancellation = await signedCancellation()
    const cancellationHash = Transaction.from(cancellation).hash
    write.mockImplementationOnce(() => { throw new Error('timeout after cancellation acceptance') })
    await expect(current.cancelPending(cancellation)).rejects.toThrow('outcome is unknown')
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(original).hash, nonce: 0, cancellationHash })
    await expect(current.send('eth_sendRawTransaction', [original])).rejects.toThrow('nonce is unresolved')
    current.destroy(); providers = []
    const restarted = provider()
    expect(await restarted.retryPending()).toBe(cancellationHash)
    expect(JSON.parse(write.mock.calls[2][1].body as string).params).toEqual([cancellation])
    latest = confirmed = 1n
    const next = await signed({ nonce: 1 })
    expect(await restarted.send('eth_sendRawTransaction', [next])).toBe(Transaction.from(next).hash)
    expect(restarted.pendingTransaction()).toEqual({ hash: Transaction.from(next).hash, nonce: 1 })
  })

  it('requires explicit operator-signed cancellation of the existing nonce and never permits a withdrawal through recovery', async () => {
    const current = provider()
    const cancellation = await signedCancellation()
    await expect(current.cancelPending(cancellation)).rejects.toThrow('existing journaled operator nonce')
    await current.send('eth_sendRawTransaction', [await signed()])
    for (const overrides of [{ nonce: 1 }, { value: 1n }, { to: ephemeral.address }, { data: '0x1234' }, { gasLimit: 22_000n }, { maxPriorityFeePerGas: 0n }]) {
      await expect(current.cancelPending(await signedCancellation(overrides))).rejects.toThrow()
    }
    expect(write).toHaveBeenCalledTimes(1)
    expect(current.pendingTransaction()?.cancellationHash).toBeUndefined()
  })

  it('does not let an old delayed cancellation retry overwrite a newer explicit signed cancellation', async () => {
    const first = provider(), second = provider()
    await first.send('eth_sendRawTransaction', [await signed()])
    await first.cancelPending(await signedCancellation())
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let reached!: () => void
    const paused = new Promise<void>((resolve) => { reached = resolve })
    nextBlockRead = async () => { reached(); await gate }
    const retry = first.retryPending()
    // Attach the rejection assertion before releasing the blocked read.
    const rejected = expect(retry).rejects.toThrow('pending transaction changed')
    await paused
    const replacement = await signedCancellation({ maxFeePerGas: 4_000_000_000n })
    const replacementHash = Transaction.from(replacement).hash
    try { await second.cancelPending(replacement) } finally { release() }
    await rejected
    expect(first.pendingTransaction()?.cancellationHash).toBe(replacementHash)
    first.destroy(); second.destroy(); providers = []
    const restarted = provider()
    expect(await restarted.retryPending()).toBe(replacementHash)
    expect(JSON.parse(write.mock.calls.at(-1)![1].body as string).params).toEqual([replacement])
  })
})
