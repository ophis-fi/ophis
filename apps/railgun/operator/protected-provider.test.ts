import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NETWORK_CONFIG, NetworkName } from '@railgun-community/shared-models'
import { decodeRlp, encodeRlp, FetchRequest, Transaction, Wallet } from 'ethers'
import { PROTECTED_WRITE_RPC, protectedWriteRPC, ProtectedEthereumProvider } from './protected-provider'
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
let height: bigint
let headTimestamp: number
const bundleHash = `0x${'ab'.repeat(32)}`

async function signed(overrides = {}, chainId = 1): Promise<string> {
  const network = NETWORK_CONFIG[chainId === 56 ? NetworkName.BNBChain : chainId === 42161 ? NetworkName.Arbitrum
    : chainId === 137 ? NetworkName.Polygon : NetworkName.Ethereum]
  const auth = await ephemeral.authorize({ address: network.relayAdapt7702Contract, chainId, nonce: 0 })
  return operator.signTransaction({
    type: 4, chainId, nonce: 0, to: ephemeral.address, authorizationList: [auth],
    data: '0x12345678', value: 0n, gasLimit: 1_000_000n,
    maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, ...overrides,
  })
}

function provider(guard?: string, chainId = 1, operatorAddress = operator.address): ProtectedEthereumProvider {
  const request = new FetchRequest(readURL)
  request.setHeader('Authorization', 'private-read-node-credential')
  const result = new ProtectedEthereumProvider(request, operatorAddress, directory, guard, chainId)
  providers.push(result)
  return result
}

function signedCancellation(overrides = {}, chainId = 1): Promise<string> {
  return operator.signTransaction({ type: 2, chainId, nonce: 0, to: operator.address,
    value: 0n, data: '0x', gasLimit: 21_000n, maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n, ...overrides })
}

describe('explicit reorg recovery staging', () => {
  it('retains both original operations and the newest cancellation while recovering lower nonces across restart', async () => {
    const current = provider(), first = await signed(), second = await signed({ nonce: 1 })
    await current.stageSigned(first)
    latest = confirmed = 1n
    await current.stageSigned(second)
    const cancelled = await signedCancellation({ nonce: 1 })
    await current.cancelPending(cancelled)
    const displaced = current.pendingTransaction()!
    latest = confirmed = 0n
    await expect(current.stageSigned(first)).rejects.toThrow('nonce is unresolved')
    await current.stageRecovery(first, displaced)
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(first).hash, nonce: 0 })
    expect(write).toHaveBeenCalledTimes(1)
    current.destroy()
    const restarted = provider()
    expect(await restarted.retryPending()).toBe(Transaction.from(first).hash)
    latest = confirmed = 1n
    await restarted.stageSigned(second)
    expect(restarted.pendingTransaction()).toEqual(displaced)
    expect(await restarted.retryPending()).toBe(Transaction.from(cancelled).hash)
    const saved = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      expect(saved.prepare('SELECT raw FROM operation_history ORDER BY nonce').all().map(row => row.raw)).toEqual([first, second])
      expect(saved.prepare('SELECT raw FROM cancellation_history').get()?.raw).toBe(cancelled)
      expect(() => saved.exec('DELETE FROM operation_history')).toThrow('append-only')
    } finally { saved.close() }
  })

  it('rejects changed snapshots, different signed bytes for a retained nonce, and writes that cannot commit', async () => {
    const current = provider(), first = await signed(), second = await signed({ nonce: 1 })
    await current.stageSigned(first)
    latest = confirmed = 1n
    await current.stageSigned(second)
    const displaced = current.pendingTransaction()!
    latest = confirmed = 0n
    await expect(current.stageRecovery(first, { ...displaced, cancellationHash: `0x${'11'.repeat(32)}` })).rejects.toThrow('pointer')
    await expect(current.stageRecovery(await signed({ data: '0x87654321' }), displaced)).rejects.toThrow('already owns')
    expect(current.pendingTransaction()).toEqual(displaced)
    const saved = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      saved.exec(`CREATE TRIGGER fail_recovery_insert BEFORE INSERT ON pending WHEN NEW.nonce=0
        BEGIN SELECT RAISE(ABORT, 'Synthetic interrupted pointer write'); END`)
      await expect(current.stageRecovery(first, displaced)).rejects.toThrow('interrupted pointer write')
      expect(current.pendingTransaction()).toEqual(displaced)
      expect(saved.prepare('SELECT COUNT(*) AS count FROM operation_history').get()?.count).toBe(2)
      saved.exec('DROP TRIGGER fail_recovery_insert')
    } finally { saved.close() }
    expect(write).not.toHaveBeenCalled()
    current.destroy()
    expect(await provider().stageRecovery(first, displaced)).toBe(Transaction.from(first).hash)
  })

  it('does not renew an expired original BNB envelope when rewinding its pending pointer', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), first = await signed({}, 56), second = await signed({ nonce: 1 }, 56)
    await current.broadcastTransaction(first, Date.now() + 60_000)
    latest = confirmed = 1n
    await current.broadcastTransaction(second, Date.now() + 60_000)
    const displaced = current.pendingTransaction()!
    const saved = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      const body = String(saved.prepare('SELECT body FROM protected_bundles WHERE hash=?').get(Transaction.from(first).hash!)?.body)
      height = BigInt(JSON.parse(body).params[0].maxBlockNumber) + 1n
      latest = confirmed = 0n
      await current.stageRecovery(first, displaced)
      await expect(current.retryPending()).rejects.toThrow(/expired/i)
      expect(saved.prepare('SELECT body FROM protected_bundles WHERE hash=?').get(Transaction.from(first).hash!)?.body).toBe(body)
      expect(current.pendingTransaction()?.hash).toBe(Transaction.from(first).hash)
      expect(saved.prepare('SELECT COUNT(*) AS count FROM operation_history').get()?.count).toBe(2)
      expect(write).toHaveBeenCalledTimes(2)
    } finally { saved.close() }
  })
})

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ophis-protected-provider-'))
  providers = []; reads = []; latest = 0n; confirmed = 0n; chain = '0x1'; fork = false; forkError = false; nextBlockRead = undefined
  executionGuard = undefined; guardCode = undefined
  height = 100n; headTimestamp = Math.floor(Date.now() / 1000)
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
      case 'eth_blockNumber': result = `0x${height.toString(16)}`; break
      case 'eth_getBlockByNumber': result = { number: `0x${height.toString(16)}`, timestamp: `0x${headTimestamp.toString(16)}`, hash: `0x${'cd'.repeat(32)}` }; break
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
    const { method, params } = JSON.parse(options.body as string)
    return Response.json({ jsonrpc: '2.0', id: 1, result: method === 'eth_sendBundle' ? bundleHash : Transaction.from(params[0]).hash })
  })
  // Ethers uses its own HTTP transport for reads. No test can send a transaction outside this process.
  vi.stubGlobal('fetch', write)
})

afterEach(async () => {
  for (const current of providers) current.destroy()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('protected operator transport', () => {
  it('allows only fixed qualified endpoints and rejects unsupported chains before creating state', () => {
    expect(protectedWriteRPC()).toBe(PROTECTED_WRITE_RPC)
    expect(protectedWriteRPC(56)).toBe('https://puissant-builder.48.club/')
    for (const chainId of [42161, 137, 8453]) expect(() => protectedWriteRPC(chainId)).toThrow('no qualified')
    const rejectedDirectory = join(directory, 'unsupported')
    expect(() => new ProtectedEthereumProvider(readURL, operator.address, rejectedDirectory, undefined, 8453))
      .toThrow('Unsupported')
    expect(existsSync(rejectedDirectory)).toBe(false)
    expect(reads).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it.each([42161, 56, 137])('stages chain %s requests while rejecting replayed outer chains, authorizations and delegates', async (chainId) => {
    chain = `0x${chainId.toString(16)}`
    const current = provider(undefined, chainId)
    const network = NETWORK_CONFIG[chainId === 56 ? NetworkName.BNBChain : chainId === 42161 ? NetworkName.Arbitrum : NetworkName.Polygon]
    const raw = await signed({}, chainId)
    expect(await current.stageSigned(raw)).toBe(Transaction.from(raw).hash)
    const wrongChain = await ephemeral.authorize({ address: network.relayAdapt7702Contract, chainId: 1, nonce: 0 })
    const wrongDelegate = await ephemeral.authorize({ address: config.relayAdapt7702Contract, chainId, nonce: 0 })
    for (const rejected of [await signed(), await signed({ authorizationList: [wrongChain] }, chainId),
      await signed({ authorizationList: [wrongDelegate] }, chainId)]) {
      await expect(current.stageSigned(rejected)).rejects.toThrow()
    }
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    expect(reads.filter((call) => call.method === 'eth_getTransactionCount').map((call) => call.params[1]))
      .toEqual(['latest', 'finalized'])
    expect(write).not.toHaveBeenCalled()
  })

  it.each([42161, 137])('keeps chain %s unpublishable without weakening its staged recovery lock', async (chainId) => {
    chain = `0x${chainId.toString(16)}`
    const current = provider(undefined, chainId)
    const raw = await signed({}, chainId)
    await current.stageSigned(raw)
    await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow('no qualified')
    await expect(current.retryPending()).rejects.toThrow('no qualified')
    await expect(current.cancelPending(await signedCancellation({ gasLimit: 24_000n }, chainId))).rejects.toThrow('no qualified')
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    expect(write).not.toHaveBeenCalled()
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
  })

  it('pins BNB guarded publication to its selected delegate and fixed private endpoint', async () => {
    chain = '0x38'
    const delegate = NETWORK_CONFIG[NetworkName.BNBChain].relayAdapt7702Contract
    executionGuard = Wallet.createRandom().address
    guardCode = executionGuardCode(operator.address, '0x6001')
    const current = provider(executionGuard, 56)
    const data = EXECUTION_GUARD.encodeFunctionData('execute', [ephemeral.address, '0x3e12cc2e', 0n])
    const raw = await signed({ to: executionGuard, data }, 56)
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('reviewed artifact')
    expect(current.pendingTransaction()).toBeUndefined()
    guardCode = executionGuardCode(operator.address, '0x6001', delegate)
    expect((await current.broadcastTransaction(raw, Date.now() + 60_000)).hash).toBe(Transaction.from(raw).hash)
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0]).toBe('https://puissant-builder.48.club/')
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
  })

  it('retains BNB unknown outcomes across restart and permits only bounded empty cancellation through the private endpoint', async () => {
    chain = '0x38'
    const current = provider(undefined, 56)
    const raw = await signed({}, 56)
    write.mockImplementationOnce(() => { throw new Error('timeout') })
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('outcome is unknown')
    current.destroy()
    const restarted = provider(undefined, 56)
    await expect(restarted.broadcastTransaction(await signed({ nonce: 1 }, 56), Date.now() + 60_000)).rejects.toThrow('nonce is unresolved')
    for (const overrides of [{ gasLimit: 20_999n }, { gasLimit: 30_000_001n }, { data: '0x1234' }, { value: 1n },
      { to: ephemeral.address }]) {
      await expect(restarted.cancelPending(await signedCancellation(overrides, 56))).rejects.toThrow()
    }
    const cancellation = await signedCancellation({ gasLimit: 24_000n }, 56)
    expect(await restarted.cancelPending(cancellation)).toBe(Transaction.from(cancellation).hash)
    expect(restarted.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0,
      cancellationHash: Transaction.from(cancellation).hash })
    expect(write.mock.calls.map(([url]) => url)).toEqual(['https://puissant-builder.48.club/', 'https://puissant-builder.48.club/'])
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
    latest = 1n
    await expect(restarted.stageSigned(await signed({ nonce: 1 }, 56))).rejects.toThrow('nonce is unresolved')
    confirmed = 1n
    expect(await restarted.stageSigned(await signed({ nonce: 1 }, 56))).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('persists the exact one-transaction BNB bundle and authenticated expiry before disclosure, separately from its acknowledgment', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56), expiry = Date.now() + 12_000
    const hash = Transaction.from(raw).hash!
    write.mockImplementationOnce(async (_url, options) => {
      const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
      try {
        expect(database.prepare('SELECT hash,body,valid_until_ms FROM protected_bundles').get())
          .toEqual({ hash, body: options.body, valid_until_ms: expiry })
        expect(database.prepare('SELECT raw FROM pending').get()?.raw).toBe(raw)
      } finally { database.close() }
      expect(JSON.parse(options.body as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{
        txs: [raw], maxBlockNumber: 120, maxTimestamp: Math.floor(expiry / 1000), revertingTxHashes: [], noMerge: true,
      }] })
      return Response.json({ jsonrpc: '2.0', id: 1, result: bundleHash })
    })
    expect((await current.broadcastTransaction(raw, expiry)).hash).toBe(hash)
    expect(current.pendingTransaction()).toEqual({ hash, nonce: 0 })
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      expect(database.prepare('SELECT hash,bundle_hash FROM bundle_acknowledgments').all()).toEqual([{ hash, bundle_hash: bundleHash }])
      for (const sql of ["UPDATE protected_bundles SET body='changed'", 'DELETE FROM protected_bundles',
        'INSERT OR REPLACE INTO protected_bundles SELECT * FROM protected_bundles']) expect(() => database.exec(sql)).toThrow('append-only')
      for (const sql of ["UPDATE bundle_acknowledgments SET bundle_hash='changed'", 'DELETE FROM bundle_acknowledgments',
        'INSERT OR REPLACE INTO bundle_acknowledgments SELECT * FROM bundle_acknowledgments']) expect(() => database.exec(sql)).toThrow('append-only')
    } finally { database.close() }
    expect(reads.some((call) => call.method.startsWith('eth_send'))).toBe(false)
  })

  it('retries the identical BNB body after timeout and restart without extending either bound', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    write.mockImplementationOnce(() => { throw new Error('sensitive timeout') })
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('outcome is unknown')
    const originalBody = write.mock.calls[0][1].body
    current.destroy()
    height += 1n
    const restarted = provider(undefined, 56)
    expect(await restarted.retryPending()).toBe(Transaction.from(raw).hash)
    expect(write.mock.calls[1][1].body).toBe(originalBody)
    expect(write.mock.calls).toHaveLength(2)
  })

  it.each(['missing', 'expired', 'invalid'])('refuses a fresh BNB user bundle with %s authenticated fee expiry', async (kind) => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    const expiration = kind === 'missing' ? undefined : kind === 'expired' ? Date.now() - 1 : NaN
    await expect(current.broadcastTransaction(raw, expiration)).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(current.pendingTransaction()).toBeUndefined()
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
    try { expect(database.prepare('SELECT COUNT(*) AS n FROM protected_bundles').get()?.n).toBe(0) } finally { database.close() }
  })

  it('rejects a fresh direct raw BNB submission without creating a pending nonce row', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow('No raw submission was staged')
    expect(current.pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
    current.destroy()
    expect(provider(undefined, 56).pendingTransaction()).toBeUndefined()
  })

  it.each([-2, 2])('caps BNB bundle time against local time and a trusted head offset of %ss', async (offset) => {
    chain = '0x38'
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    headTimestamp = Math.floor(now / 1000) + offset
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await current.broadcastTransaction(raw, now + 60_000)
    const bundle = JSON.parse(write.mock.calls[0][1].body as string).params[0]
    expect(bundle.maxTimestamp).toBe(Math.min(Math.floor(now / 1000) + 30, headTimestamp + 30))
    expect(bundle.maxBlockNumber).toBe(120)
  })

  it('does not refresh a legacy raw-only BNB journal but permits an explicitly signed cancellation bundle', async () => {
    chain = '0x38'
    const original = provider(undefined, 56), raw = await signed({}, 56)
    await original.stageSigned(raw)
    original.destroy()
    const legacy = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try { legacy.exec('DROP TABLE protected_bundles; DROP TABLE bundle_acknowledgments') } finally { legacy.close() }
    const current = provider(undefined, 56)
    await expect(current.send('eth_sendRawTransaction', [raw])).rejects.toThrow('no journaled bundle')
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('no journaled bundle')
    const cancellation = await signedCancellation({ gasLimit: 24_000n }, 56)
    expect(await current.cancelPending(cancellation)).toBe(Transaction.from(cancellation).hash)
    expect(write).toHaveBeenCalledOnce()
    expect(JSON.parse(write.mock.calls[0][1].body as string).params[0].txs).toEqual([cancellation])
  })

  it.each(['block', 'time'])('retains an expired BNB %s envelope and nonce across restart until an explicit cancellation', async (kind) => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await current.broadcastTransaction(raw, Date.now() + 60_000)
    const firstBody = write.mock.calls[0][1].body
    if (kind === 'block') height += 20n
    else {
      const now = Date.now() + 31_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      headTimestamp = Math.floor(now / 1000)
    }
    current.destroy()
    const restarted = provider(undefined, 56)
    await expect(restarted.retryPending()).rejects.toThrow('expired')
    await expect(restarted.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('expired')
    expect(restarted.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    expect(write).toHaveBeenCalledOnce()
    const cancellation = await signedCancellation({ gasLimit: 24_000n }, 56)
    await restarted.cancelPending(cancellation)
    restarted.destroy()
    const again = provider(undefined, 56)
    expect(await again.retryPending()).toBe(Transaction.from(cancellation).hash)
    expect(write.mock.calls[2][1].body).toBe(write.mock.calls[1][1].body)
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
    try { expect(database.prepare('SELECT body FROM protected_bundles ORDER BY rowid').all().map((row) => row.body))
      .toEqual([firstBody, write.mock.calls[1][1].body]) } finally { database.close() }
  })

  it.each([
    ['duplicate', () => Response.json({ jsonrpc: '2.0', id: 1, error: { code: -38000, message: 'sensitive duplicate' } })],
    ['malformed bundle hash', () => Response.json({ jsonrpc: '2.0', id: 1, result: '0x1234' })],
    ['wrong id', () => Response.json({ jsonrpc: '2.0', id: 2, result: bundleHash })],
    ['malformed JSON', () => new Response('sensitive invalid JSON')],
  ])('keeps BNB signed state after %s without leaking endpoint diagnostics', async (_kind, response) => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    write.mockImplementationOnce(response)
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('outcome is unknown')
    expect(current.pendingTransaction()?.hash).toBe(Transaction.from(raw).hash)
    current.destroy()
    const restarted = provider(undefined, 56)
    expect(await restarted.retryPending()).toBe(Transaction.from(raw).hash)
    expect(write.mock.calls[1][1].body).toBe(write.mock.calls[0][1].body)
  })

  it('does not disclose a BNB operation if durable envelope persistence fails', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try { database.exec(`CREATE TRIGGER test_bundle_failure BEFORE INSERT ON protected_bundles
      BEGIN SELECT RAISE(ABORT, 'Disk write failure'); END;`) } finally { database.close() }
    await expect(current.broadcastTransaction(raw, Date.now() + 60_000)).rejects.toThrow('Disk write failure')
    expect(current.pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('keeps the original BNB retry target and history if cancellation envelope persistence fails', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await current.broadcastTransaction(raw, Date.now() + 60_000)
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try { database.exec(`CREATE TRIGGER test_bundle_failure BEFORE INSERT ON protected_bundles
      BEGIN SELECT RAISE(ABORT, 'Disk write failure'); END;`) } finally { database.close() }
    await expect(current.cancelPending(await signedCancellation({ gasLimit: 24_000n }, 56))).rejects.toThrow('Disk write failure')
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    expect(write).toHaveBeenCalledOnce()
    const saved = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
    try {
      expect(saved.prepare('SELECT COUNT(*) AS n FROM cancellation_history').get()?.n).toBe(0)
      expect(saved.prepare('SELECT COUNT(*) AS n FROM protected_bundles').get()?.n).toBe(1)
    } finally { saved.close() }
  })

  it('retries equivalent cancellation hex casing using the unchanged stored BNB envelope', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await current.broadcastTransaction(raw, Date.now() + 60_000)
    const cancellation = await signedCancellation({ gasLimit: 24_000n }, 56)
    const upper = `0x${cancellation.slice(2).toUpperCase()}`
    await current.cancelPending(upper)
    const originalBody = write.mock.calls[1][1].body
    expect(JSON.parse(originalBody as string).params[0].txs).toEqual([upper])
    expect(await current.cancelPending(cancellation)).toBe(Transaction.from(cancellation).hash)
    expect(write.mock.calls[2][1].body).toBe(originalBody)
    current.destroy()
    const restarted = provider(undefined, 56)
    expect(await restarted.retryPending()).toBe(Transaction.from(cancellation).hash)
    expect(write.mock.calls[3][1].body).toBe(originalBody)
  })

  it('sanitizes acknowledgment persistence failure after BNB publication and retains the exact retry envelope', async () => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try { database.exec(`CREATE TRIGGER test_ack_failure BEFORE INSERT ON bundle_acknowledgments
      BEGIN SELECT RAISE(ABORT, 'sensitive raw signature and endpoint credentials'); END;`) } finally { database.close() }
    const error = await current.broadcastTransaction(raw, Date.now() + 60_000).then(() => undefined, (failure) => failure)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain('outcome is unknown')
    expect(error.message).not.toContain('sensitive')
    expect(error.message).not.toContain(raw)
    expect(current.pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0 })
    expect(write).toHaveBeenCalledOnce()
    current.destroy()
    const saved = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try { saved.exec('DROP TRIGGER test_ack_failure') } finally { saved.close() }
    const restarted = provider(undefined, 56)
    expect(await restarted.retryPending()).toBe(Transaction.from(raw).hash)
    expect(write.mock.calls[1][1].body).toBe(write.mock.calls[0][1].body)
    expect(await restarted.retryPending()).toBe(Transaction.from(raw).hash)
    const acknowledgments = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
    try { expect(acknowledgments.prepare('SELECT COUNT(*) AS n FROM bundle_acknowledgments').get()?.n).toBe(1) }
    finally { acknowledgments.close() }
  })

  it.each(['body', 'raw', 'fee expiry', 'binding'])('rejects a corrupted persisted BNB %s before any restart disclosure', async (kind) => {
    chain = '0x38'
    const current = provider(undefined, 56), raw = await signed({}, 56)
    await current.broadcastTransaction(raw, Date.now() + 60_000)
    current.destroy()
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      database.exec('DROP TRIGGER preserve_bundle_update')
      if (kind === 'body') database.exec("UPDATE protected_bundles SET body='invalid signed body'")
      if (kind === 'raw') database.prepare('UPDATE protected_bundles SET hash=?').run(`0x${'ef'.repeat(32)}`)
      if (kind === 'fee expiry') database.exec('UPDATE protected_bundles SET valid_until_ms=1')
      if (kind === 'binding') database.prepare('UPDATE protected_bundles SET operator=?').run(ephemeral.address)
    } finally { database.close() }
    expect(() => provider(undefined, 56)).toThrow()
    expect(write).toHaveBeenCalledOnce()
  })

  it('rejects a stale trusted BNB head before creating or disclosing an envelope', async () => {
    chain = '0x38'; headTimestamp -= 4
    const current = provider(undefined, 56)
    await expect(current.broadcastTransaction(await signed({}, 56), Date.now() + 60_000)).rejects.toThrow('fresh')
    expect(current.pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('durably binds even an empty journal directory to one chain and operator', () => {
    const first = provider()
    first.destroy()
    expect(() => provider(undefined, 56)).toThrow('another chain or operator')
    expect(() => provider(undefined, 1, ephemeral.address)).toThrow('another chain or operator')
    expect(provider().pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('rolls first schema creation back with a failed binding and can retry on a non-Ethereum chain', () => {
    const originalExec = DatabaseSync.prototype.exec
    const fault = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      originalExec.call(this, sql)
      if (sql.includes('CREATE TABLE IF NOT EXISTS pending')) throw new Error('Interrupted first initialization')
    })
    try { expect(() => provider(undefined, 56)).toThrow('Interrupted') } finally { fault.mockRestore() }
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'), { readOnly: true })
    try { expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get()?.count).toBe(0) }
    finally { database.close() }
    expect(provider(undefined, 56).pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it('recovers a demonstrably empty pending schema left by an interrupted previous non-Ethereum startup', () => {
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    database.exec(`CREATE TABLE pending (operator TEXT PRIMARY KEY,hash TEXT NOT NULL,nonce INTEGER NOT NULL,raw TEXT NOT NULL,
      cancel_hash TEXT,cancel_raw TEXT)`)
    database.close()
    chmodSync(join(directory, 'protected-transactions.sqlite'), 0o600)
    expect(provider(undefined, 56).pendingTransaction()).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it.each(['pending', 'unrecognized-table'])('refuses a populated or unrelated unbound foreign-chain %s journal', async (kind) => {
    const database = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    database.exec(`CREATE TABLE pending (operator TEXT PRIMARY KEY,hash TEXT NOT NULL,nonce INTEGER NOT NULL,raw TEXT NOT NULL,
      cancel_hash TEXT,cancel_raw TEXT)`)
    if (kind === 'pending') {
      const raw = await signed({}, 56)
      database.prepare('INSERT INTO pending(operator,hash,nonce,raw) VALUES(?,?,?,?)').run(operator.address, Transaction.from(raw).hash!, 0, raw)
    } else database.exec('CREATE TABLE other_state (value TEXT)')
    database.close()
    chmodSync(join(directory, 'protected-transactions.sqlite'), 0o600)
    expect(() => provider(undefined, 56)).toThrow('without a chain binding')
    expect(write).not.toHaveBeenCalled()
  })

  it('migrates a verified signed legacy Ethereum journal while preserving its cancellation', async () => {
    const current = provider()
    const raw = await signed(), cancellation = await signedCancellation()
    await current.stageSigned(raw)
    await current.cancelPending(cancellation)
    current.destroy()
    const legacy = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    legacy.exec('DROP TABLE binding')
    legacy.close()
    expect(provider().pendingTransaction()).toEqual({ hash: Transaction.from(raw).hash, nonce: 0,
      cancellationHash: Transaction.from(cancellation).hash })
    expect(write).toHaveBeenCalledOnce()
  })

  it.each(['wrong chain', 'wrong operator', 'wrong hash', 'wrong cancellation'])('refuses unbound legacy journal migration with %s', async (kind) => {
    const current = provider()
    const raw = await signed()
    await current.stageSigned(raw)
    current.destroy()
    const legacy = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    legacy.exec('DROP TABLE binding')
    if (kind === 'wrong hash') legacy.prepare('UPDATE pending SET hash = ?').run('0x1234')
    if (kind === 'wrong cancellation') legacy.prepare('UPDATE pending SET cancel_raw = ?').run(await signedCancellation())
    legacy.close()
    expect(() => provider(undefined, kind === 'wrong chain' ? 56 : 1, kind === 'wrong operator' ? ephemeral.address : operator.address))
      .toThrow()
    expect(write).not.toHaveBeenCalled()
  })

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

  it('retains older cancellations after replacement, exact retries, restart and pending nonce turnover', async () => {
    const current = provider(), original = await signed()
    const first = await signedCancellation(), latestCancellation = await signedCancellation({ maxFeePerGas: 4_000_000_000n })
    const firstHash = Transaction.from(first).hash!, latestHash = Transaction.from(latestCancellation).hash!
    await current.send('eth_sendRawTransaction', [original])
    await current.cancelPending(first); await current.cancelPending(latestCancellation)
    current.destroy(); providers = []
    const restarted = provider()
    expect(await restarted.retryPending()).toBe(latestHash)
    expect(JSON.parse(write.mock.calls.at(-1)![1].body as string).params).toEqual([latestCancellation])
    const calls = write.mock.calls.length
    await expect(restarted.cancelPending(first)).rejects.toThrow('earlier cancellation')
    expect(write).toHaveBeenCalledTimes(calls)
    expect(restarted.pendingTransaction()?.cancellationHash).toBe(latestHash)
    latest = confirmed = 1n
    await restarted.stageSigned(await signed({ nonce: 1 }))
    restarted.destroy(); providers = []
    const again = provider()
    await expect(again.cancelPending(first)).rejects.toThrow('existing journaled operator nonce')
    const history = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
    try {
      expect(history.prepare('SELECT hash,raw,nonce FROM cancellation_history ORDER BY rowid').all()).toEqual([
        { hash: firstHash, raw: first, nonce: 0 }, { hash: latestHash, raw: latestCancellation, nonce: 0 },
      ])
      for (const sql of ['UPDATE cancellation_history SET raw=\'changed\'', 'DELETE FROM cancellation_history',
        'INSERT OR REPLACE INTO cancellation_history SELECT * FROM cancellation_history LIMIT 1'])
        expect(() => history.exec(sql)).toThrow('append-only')
    } finally { history.close() }
  })

  it.each(['chain', 'operator', 'nonce', 'hash', 'original', 'raw'])(
    'validates an older retained cancellation with wrong %s when reopening a bound journal', async (kind) => {
      const current = provider(), original = await signed(), first = await signedCancellation()
      const firstHash = Transaction.from(first).hash!
      await current.stageSigned(original)
      await current.cancelPending(first)
      await current.cancelPending(await signedCancellation({ maxFeePerGas: 4_000_000_000n }))
      current.destroy(); providers = []
      const damaged = new DatabaseSync(join(directory, 'protected-transactions.sqlite'))
      damaged.exec('DROP TRIGGER preserve_cancellation_update')
      if (kind === 'chain') damaged.prepare('UPDATE cancellation_history SET raw=? WHERE hash=?').run(await signedCancellation({}, 56), firstHash)
      if (kind === 'operator') damaged.prepare('UPDATE cancellation_history SET operator=? WHERE hash=?').run(ephemeral.address, firstHash)
      if (kind === 'nonce') damaged.prepare('UPDATE cancellation_history SET nonce=1 WHERE hash=?').run(firstHash)
      if (kind === 'hash') damaged.prepare('UPDATE cancellation_history SET hash=? WHERE hash=?').run(`0x${'ab'.repeat(32)}`, firstHash)
      if (kind === 'original') damaged.prepare('UPDATE cancellation_history SET original_hash=? WHERE hash=?').run(`0x${'cd'.repeat(32)}`, firstHash)
      if (kind === 'raw') damaged.prepare('UPDATE cancellation_history SET raw=? WHERE hash=?').run('invalid-signed-payload', firstHash)
      damaged.close()
      expect(() => provider()).toThrow()
    },
  )
})
