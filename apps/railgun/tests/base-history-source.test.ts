import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Interface, id, type JsonRpcProvider } from 'ethers'
import { ABIRailgunSmartWallet } from '@railgun-community/engine'
import { BASE_HISTORY as B, baseHistoryOrigin, historyDigest, validateHistoryLogs } from '../base-history'
import { createBaseHistorySource, decodeBaseHistory } from '../base-history-sdk'

afterEach(() => vi.unstubAllGlobals())
const abi = new Interface(ABIRailgunSmartWallet), hex = (v: number) => `0x${v.toString(16)}`
async function fixture() {
  const end = B.fromBlock + 9, head = end + 5, root = id('empty-root'), timestamp = Math.floor(Date.now() / 1000)
  const body = '[]', page = { fromBlock: B.fromBlock, toBlock: end, hash: await historyDigest(body), bytes: 2, count: 0 }
  const core = { version: 1, chainId: 8453, address: B.address, fromBlock: B.fromBlock, toBlock: end,
    blockHash: id(`block:${end}`), timestamp, pages: [page] }
  const manifest = { ...core, generation: await historyDigest(JSON.stringify(core)) }
  const tail = { generation: manifest.generation, fromBlock: end + 1, toBlock: head, blockHash: id(`block:${head}`), timestamp, logs: [] }
  const send = vi.fn(async (method: string, params: any[]) => {
    if (method === 'eth_getBlockByNumber') {
      const number = params[0] === 'finalized' ? end : Number(BigInt(params[0]))
      return { number: hex(number), hash: id(`block:${number}`), timestamp: hex(timestamp) }
    }
    expect(method).toBe('eth_call'); expect(params[1]).toBe(hex(head))
    const name = abi.parseTransaction({ data: params[0].data })!.name
    return abi.encodeFunctionResult(name, [name === 'merkleRoot' ? root : 0])
  })
  const fetch = vi.fn(async (url: URL | string) => new Response(String(url).endsWith('/manifest') ? JSON.stringify(manifest) :
    String(url).includes('/tail/') ? JSON.stringify(tail) : body, { status: 200 }))
  vi.stubGlobal('fetch', fetch)
  const provider = { getNetwork: async () => ({ chainId: 8453n }), send } as unknown as JsonRpcProvider
  const tree = { hasPendingWrites: () => false, getFirstInvalidMerklerootTree: () => undefined,
    getLatestTreeAndIndex: async () => ({ tree: 0, index: -1 }), getRoot: async () => root,
    getTreeLength: async () => 0 }
  return { manifest, tail, provider, tree, send, fetch, end, head }
}

it('verifies complete empty spans and canonical head without log RPC or indexer fallback', async () => {
  const f = await fixture(), source = await createBaseHistorySource(f.provider, 'http://127.0.0.1:4319')
  const result = await source()
  expect(result.events).toEqual({ commitmentEvents: [], nullifierEvents: [], unshieldEvents: [] })
  await result.validate(f.tree as never)
  expect(f.send).toHaveBeenCalledTimes(9)
  expect(result.checkpoint).toEqual({ blockNumber: f.head, blockHash: f.tail.blockHash })
  expect(f.send.mock.calls.every(([method]) => method === 'eth_getBlockByNumber' || method === 'eth_call')).toBe(true)
  const reads = f.fetch.mock.calls.filter(([url]) => String(url).includes('/page/')).length
  await source(result.checkpoint)
  expect(f.fetch.mock.calls.filter(([url]) => String(url).includes('/page/'))).toHaveLength(reads)
})

it('rejects a stale canonical tail whose cache timestamp was forged fresh without extra RPC reads', async () => {
  const f = await fixture(), original = f.send.getMockImplementation()!
  f.manifest.timestamp -= 600
  const { generation: _generation, ...core } = f.manifest
  f.manifest.generation = await historyDigest(JSON.stringify(core))
  f.tail.generation = f.manifest.generation
  f.send.mockImplementation(async (method, params) => {
    const value = await original(method, params)
    return method === 'eth_getBlockByNumber' && typeof value !== 'string' ? { ...value,
      timestamp: hex(f.manifest.timestamp + (params[0] === hex(f.head) ? 10 : 0)) } : value
  })
  const source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
  await expect(source()).rejects.toThrow('trusted provider')
  expect(f.send).toHaveBeenCalledTimes(4)
  expect(f.send.mock.calls.some(([method]) => method === 'eth_call')).toBe(false)
})

it('allows lengthy local ingestion of a fresh acquisition while still verifying its exact canonical evidence', async () => {
  const f = await fixture(), source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
  const scan = await source()
  const clock = vi.spyOn(Date, 'now').mockReturnValue((f.tail.timestamp + 120) * 1000)
  try {
    await expect(scan.validate(f.tree as never)).resolves.toBeUndefined()
    clock.mockReturnValue((f.tail.timestamp + 600) * 1000)
    await expect(scan.validate(f.tree as never)).resolves.toBeUndefined()
    expect(() => source.assertReceiptCoverage()).not.toThrow()
    await expect(source()).rejects.toThrow('not current')
  }
  finally { clock.mockRestore() }
})

it.each(['hash', 'timestamp'] as const)('still rejects a changed canonical %s after lengthy local ingestion', async field => {
  const f = await fixture(), source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
  const scan = await source(), original = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => {
    const value = await original(method, params)
    return method === 'eth_getBlockByNumber' && params[0] === hex(f.head) && typeof value !== 'string'
      ? { ...value, ...(field === 'hash' ? { hash: id('changed after ingestion') } : { timestamp: hex(f.tail.timestamp + 1) }) }
      : value
  })
  const clock = vi.spyOn(Date, 'now').mockReturnValue((f.tail.timestamp + 120) * 1000)
  try { await expect(scan.validate(f.tree as never)).rejects.toThrow('anchor differs') }
  finally { clock.mockRestore() }
})

it.each(['warming', 'bad-page', 'not-finalized', 'wrong-root', 'ahead'])('keeps %s history unusable without fallback', async reason => {
  const f = await fixture(), fetch = f.fetch.getMockImplementation()!, send = f.send.getMockImplementation()!
  if (reason === 'warming') f.fetch.mockResolvedValue(new Response('{}', { status: 202 }))
  if (reason === 'bad-page') f.fetch.mockImplementation(async url => String(url).includes('/page/') ? new Response('[ ]') : fetch(url))
  if (reason === 'not-finalized') f.send.mockImplementation(async (method, params) => method === 'eth_getBlockByNumber' && params[0] === 'finalized'
    ? { number: hex(f.end - 1), hash: id('older'), timestamp: hex(Math.floor(Date.now() / 1000)) } : send(method, params))
  if (['warming', 'bad-page', 'not-finalized'].includes(reason))
    await expect(createBaseHistorySource(f.provider, 'https://swap.ophis.fi')).rejects.toThrow()
  else {
    const source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
    if (reason === 'ahead') await expect(source({ blockNumber: f.head + 1, blockHash: id(`block:${f.head + 1}`) })).rejects.toThrow('not current')
    else await expect((await source()).validate({ ...f.tree, getRoot: async () => id('different') } as never)).rejects.toThrow('canonical tree')
  }
})

it('distinguishes a reorged clean checkpoint from transient read failure', async () => {
  const f = await fixture(), source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
  await expect(source({ blockNumber: f.head, blockHash: id('orphan') })).rejects.toMatchObject({ requiresBaseHistoryRescan: true })
  f.send.mockRejectedValue(new Error('temporary transport'))
  await expect(source({ blockNumber: f.head, blockHash: f.tail.blockHash })).rejects.toThrow('temporary transport')
})

it('keeps mined receipt coverage pending while the shared cache lags, then accepts the canonical matching head', async () => {
  const f = await fixture(), source = await createBaseHistorySource(f.provider, 'https://swap.ophis.fi')
  const receipt = { hash: id('receipt'), blockNumber: f.head + 1, blockHash: id(`block:${f.head + 1}`) }
  source.setRequiredReceipts([receipt])
  await expect(source()).rejects.toThrow('catching up')
  expect(f.send.mock.calls.some(([method]) => method === 'eth_call')).toBe(false)
  await expect(Promise.resolve().then(() => source.assertReceiptCoverage())).rejects.toThrow('not covered')
  f.tail.toBlock++; f.tail.blockHash = receipt.blockHash
  const original = f.send.getMockImplementation()!
  f.send.mockImplementation(async (method, params) => method === 'eth_call' ? original(method, [params[0], hex(f.head)]) : original(method, params))
  const scan = await source(); await scan.validate(f.tree as never)
  expect(() => source.assertReceiptCoverage()).not.toThrow()
  source.setRequiredReceipts([{ ...receipt, hash: id('new receipt'), blockNumber: receipt.blockNumber + 1 }])
  expect(() => source.assertReceiptCoverage()).toThrow('not covered')
})

it('pins origins and rejects unknown future state events', () => {
  expect(baseHistoryOrigin()).toBe('https://swap.ophis.fi')
  expect(() => baseHistoryOrigin('http://127.0.0.1:4319')).toThrow()
  expect(baseHistoryOrigin('http://127.0.0.1:4319', true)).toBe('http://127.0.0.1:4319')
  for (const url of ['https://example.com', 'https://swap.ophis.fi/path', 'http://user@localhost']) expect(() => baseHistoryOrigin(url, true)).toThrow()
  expect(() => decodeBaseHistory([{ topics: [id('UnknownEvent()')], data: '0x' } as never])).toThrow('Unknown')
})

it.skipIf(!process.env.RAILGUN_BASE_HISTORY_PUBLIC_FIXTURE)('decodes the actual public Base snapshot and fits every fixed page', () => {
  const cache = JSON.parse(readFileSync(process.env.RAILGUN_BASE_HISTORY_PUBLIC_FIXTURE!, 'utf8'))
  expect(cache.chainId).toBe(8453); expect(cache.fromBlock).toBe(B.fromBlock)
  const logs = validateHistoryLogs(cache.logs, cache.fromBlock, cache.toBlock)
  const events = decodeBaseHistory(logs)
  let largest = 0
  for (let from = B.fromBlock; from <= cache.toBlock; from += B.width) {
    const page = logs.filter(log => Number(BigInt(log.blockNumber)) >= from && Number(BigInt(log.blockNumber)) < from + B.width)
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(page)))
  }
  expect(largest).toBeLessThanOrEqual(B.pageBytes)
  expect(events.commitmentEvents.length).toBeGreaterThan(0)
  console.log(JSON.stringify({ publicHistoryCompatibility: true, logs: logs.length, largestPageBytes: largest,
    commitmentEvents: events.commitmentEvents.length, nullifiers: events.nullifierEvents.length, unshields: events.unshieldEvents.length }))
})
