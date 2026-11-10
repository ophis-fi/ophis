import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { id, type JsonRpcProvider, type Log } from 'ethers'
import { NETWORK } from '../src/config'
import { PROXY } from '../src/transaction'
import { finalizedBackingHead, unspentBackingHead, type BackingNote } from '../src/credit-nullifier-checkpoint'

let now: number, final: number, latest: number, logs: Log[], hashes: Map<number, string>
let rpc: { getBlock: ReturnType<typeof vi.fn>; call: ReturnType<typeof vi.fn>; getLogs: ReturnType<typeof vi.fn> }
let provider: JsonRpcProvider
const hash = (number: number) => hashes.get(number) ?? id(`block-${number}`)
const note = (number = 0): BackingNote => ({ key: `exact-note-provenance-${number}`, tree: 0,
  nullifier: id(`nullifier-${number}`), blockNumber: 90, blockHash: id('block-90') })
function event(blockNumber: number, nullifier = id('unrelated'), index = 0): Log {
  return { address: NETWORK.proxyContract, ...PROXY.encodeEventLog(PROXY.getEvent('Nullified')!, [0, [nullifier]]),
    blockNumber, blockHash: hash(blockNumber), transactionHash: id(`tx-${blockNumber}-${index}`),
    transactionIndex: index, index, removed: false } as unknown as Log
}
async function verify(notes = [note()]) { return unspentBackingHead(provider, notes, await finalizedBackingHead(provider)) }

beforeEach(() => {
  now = 1_800_000_000_000; final = 100; latest = 100; logs = []; hashes = new Map()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  rpc = {
    getBlock: vi.fn(async (tag: number | string) => {
      const number = tag === 'finalized' ? final : tag === 'latest' ? latest : Number(tag)
      return { number, hash: hash(number), timestamp: Math.floor(now / 1000) }
    }),
    call: vi.fn(async () => PROXY.encodeFunctionResult('nullifiers', [false])),
    getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: number; toBlock: number }) =>
      logs.filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)),
  }
  provider = rpc as unknown as JsonRpcProvider
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('progressive canonical credit backing', () => {
  it('finishes a thousands-note cold scan exceeding 45 seconds, then avoids per-note calls', async () => {
    const notes = Array.from({ length: 2500 }, (_, index) => note(index))
    const start = now, timestamps = new Map([[90, start - 120_000], [100, start], [120, start + 238_000],
      [121, start + 250_000], [122, start + 262_000], [123, start + 274_000]])
    rpc.getBlock.mockImplementation(async (tag) => {
      const number = tag === 'finalized' ? final : tag === 'latest' ? latest : Number(tag)
      return { number, hash: hash(number), timestamp: Math.floor((timestamps.get(number) ?? start) / 1000) }
    })
    rpc.call.mockImplementation(async (request) => {
      expect(request.blockTag).toBe(100); now += 100
      if (now === start + 250_000) { final = 120; latest = 121 }
      return PROXY.encodeFunctionResult('nullifiers', [false])
    })
    expect((await verify(notes)).timestamp).toBe(Math.floor(now / 1000))
    expect(now - start).toBe(250_000)
    expect((await provider.getBlock(100))?.timestamp).toBe(start / 1000)
    expect(rpc.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock])).toEqual([[101, 120], [121, 121]])
    expect(rpc.call).toHaveBeenCalledTimes(2500)
    expect(rpc.getBlock.mock.calls.filter(([tag]) => tag === 90)).toHaveLength(1)
    now += 24_000; latest = 123; logs = [event(122)]
    await verify(notes)
    expect(rpc.call).toHaveBeenCalledTimes(2500)
    expect(rpc.getLogs).toHaveBeenCalledWith(expect.objectContaining({ fromBlock: 121, toBlock: 123 }))
  })

  it('detects an owned spend mined while the cold note scan is running', async () => {
    rpc.call.mockImplementation(async () => { now += 60_000; latest = 101; logs = [event(101, note().nullifier)]
      return PROXY.encodeFunctionResult('nullifiers', [false]) })
    await expect(verify()).rejects.toThrow('owner spend')
  })

  it('advances old and new notes to common finality, checking only new exact identities', async () => {
    await verify()
    final = 102; latest = 103; logs = [event(101), event(103)]
    await verify([note(), note(1)])
    expect(rpc.call).toHaveBeenCalledTimes(2)
    expect(rpc.call.mock.calls[1][0].blockTag).toBe(102)
    expect(rpc.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock])).toEqual([[101, 102], [103, 103]])
    await verify([{ ...note(), key: 'changed-amount-or-provenance' }, note(1)])
    expect(rpc.call).toHaveBeenCalledTimes(3)
  })

  it('evicts removed eligible identities instead of retaining stale wallet entries', async () => {
    await verify(); await verify([]); await verify()
    expect(rpc.call).toHaveBeenCalledTimes(2)
  })

  it('rebuilds after finalized checkpoint reorganization and rejects changed note provenance', async () => {
    await verify(); hashes.set(100, id('reorganized-finality'))
    await verify(); expect(rpc.call).toHaveBeenCalledTimes(2)
    hashes.set(100, id('second-reorganization')); hashes.set(90, id('changed-note-origin'))
    await expect(verify()).rejects.toThrow('fee-note history')
  })

  it('retains finalized progress across a shallow latest reorg and retries transient missing heads', async () => {
    await verify(); latest = 101
    rpc.getLogs.mockImplementationOnce(async () => { hashes.set(101, id('new-latest-branch')); return [] })
    await expect(verify()).rejects.toThrow('head changed')
    rpc.getBlock.mockImplementationOnce(async () => null)
    await expect(verify()).rejects.toThrow('unavailable')
    await verify(); expect(rpc.call).toHaveBeenCalledTimes(1)
  })

  it('catches an owned spend in the newest head even when the finalized cache is reusable', async () => {
    await verify(); latest = 101; logs = [event(101, note().nullifier)]
    await expect(verify()).rejects.toThrow('owner spend')
    expect(rpc.call).toHaveBeenCalledTimes(1)
  })

  it('continues from a completed latest range when that range takes more than 45 seconds', async () => {
    latest = 101
    rpc.getLogs.mockImplementationOnce(async () => { now += 60_000; latest = 102; return [] })
    expect((await verify()).number).toBe(102)
    expect(rpc.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock])).toEqual([[101, 101], [102, 102]])
  })

  it('splits oversized ranges without truncating and bounds each range to 64 blocks', async () => {
    latest = 230
    rpc.getLogs.mockImplementation(async ({ fromBlock, toBlock }) => toBlock - fromBlock >= 63 ? Array(4097).fill(event(fromBlock)) : [])
    await verify()
    expect(rpc.getLogs.mock.calls.map(([filter]) => [filter.fromBlock, filter.toBlock])).toEqual([
      [101, 164], [101, 132], [133, 164], [165, 228], [165, 196], [197, 228], [229, 230]])
    latest = 101; rpc.getLogs.mockResolvedValue(Array(4097).fill(event(101)))
    await expect(verify()).rejects.toThrow('response bound')
  })

  it.each([
    ['removed', (log: Log) => ({ ...log, removed: true })],
    ['address', (log: Log) => ({ ...log, address: '0x' + '11'.repeat(20) })],
    ['topic', (log: Log) => ({ ...log, topics: [id('wrong-topic')] })],
    ['extra-topic', (log: Log) => ({ ...log, topics: [...log.topics, id('extra')] })],
    ['range', (log: Log) => ({ ...log, blockNumber: 99 })],
    ['block-hash', (log: Log) => ({ ...log, blockHash: id('noncanonical-block') })],
    ['transaction-hash', (log: Log) => ({ ...log, transactionHash: '0x01' })],
    ['index', (log: Log) => ({ ...log, index: -1 })],
    ['transaction-index', (log: Log) => ({ ...log, transactionIndex: -1 })],
    ['data', (log: Log) => ({ ...log, data: log.data + '00' })],
  ])('rejects malformed %s evidence', async (_label, mutate) => {
    latest = 101; rpc.getLogs.mockResolvedValue([mutate(event(101))])
    await expect(verify()).rejects.toThrow()
  })

  it('rejects unordered, duplicate, empty and oversized nullifier events', async () => {
    latest = 101
    for (const values of [[event(101, id('b'), 1), event(101, id('a'), 0)], [event(101), event(101)]]) {
      rpc.getLogs.mockResolvedValue(values); await expect(verify()).rejects.toThrow('Malformed')
    }
    for (const nullifiers of [[], [id('x'), id('x')], Array.from({ length: 1025 }, (_, index) => id(`item-${index}`))]) {
      rpc.getLogs.mockResolvedValue([{ ...event(101), ...PROXY.encodeEventLog(PROXY.getEvent('Nullified')!, [0, nullifiers]) }])
      await expect(verify()).rejects.toThrow()
    }
  })

  it('rejects a spent anchor mapping and duplicate accounted nullifiers', async () => {
    rpc.call.mockResolvedValue(PROXY.encodeFunctionResult('nullifiers', [true]))
    await expect(verify()).rejects.toThrow('owner spend')
    await expect(verify([note(), { ...note(), key: 'different-note' }])).rejects.toThrow('Duplicate accounted input')
  })

  it('rolls the finalized anchor before a nonarchive RPC prunes old state during a long scan', async () => {
    const start = now, notes = Array.from({ length: 160 }, (_, index) => note(index))
    rpc.getBlock.mockImplementation(async (tag) => {
      const number = tag === 'finalized' ? final : tag === 'latest' ? latest : Number(tag)
      return { number, hash: hash(number), timestamp: Math.floor(start / 1000) + number - 100 }
    })
    rpc.call.mockImplementation(async (request) => {
      if (latest - Number(request.blockTag) > 64) throw new Error('Historical state pruned')
      now += 1000; final++; latest++
      return PROXY.encodeFunctionResult('nullifiers', [false])
    })
    expect((await verify(notes)).number).toBe(260)
    expect(now - start).toBe(160_000)
    expect([...new Set(rpc.call.mock.calls.map(([request]) => request.blockTag))]).toEqual([100,116,132,148,164,180,196,212,228,244])
    await expect(provider.call({ to: NETWORK.proxyContract,
      data: PROXY.encodeFunctionData('nullifiers', [0, note().nullifier]), blockTag: 100 })).rejects.toThrow('Historical state pruned')
  })

  it('retains only completed batch keys after a transient failure and resumes unfinished notes', async () => {
    const notes = Array.from({ length: 32 }, (_, index) => note(index))
    let reads = 0
    rpc.call.mockImplementation(async () => {
      if (++reads === 17) throw new Error('Temporary RPC failure')
      return PROXY.encodeFunctionResult('nullifiers', [false])
    })
    await expect(verify(notes)).rejects.toThrow('Temporary RPC failure')
    rpc.call.mockClear().mockResolvedValue(PROXY.encodeFunctionResult('nullifiers', [false]))
    await verify(notes)
    expect(rpc.call).toHaveBeenCalledTimes(16)
    const called = rpc.call.mock.calls.map(([request]) => PROXY.decodeFunctionData('nullifiers', request.data)[1])
    expect(new Set(called)).toEqual(new Set(notes.slice(16).map((item) => item.nullifier)))
  })

  it('checks all original owned nullifiers for a spend finalized between note batches', async () => {
    const notes = Array.from({ length: 32 }, (_, index) => note(index))
    let reads = 0
    rpc.call.mockImplementation(async () => {
      if (++reads === 16) { final = 101; latest = 101; logs = [event(101, notes[31].nullifier)] }
      return PROXY.encodeFunctionResult('nullifiers', [false])
    })
    await expect(verify(notes)).rejects.toThrow('owner spend')
    expect(rpc.call).toHaveBeenCalledTimes(16)
  })

  it('keeps canonical warm progress when the finalized tag temporarily regresses', async () => {
    await verify(); final = 99
    await expect(verify()).rejects.toThrow('head regressed')
    final = 100; await verify()
    expect(rpc.call).toHaveBeenCalledTimes(1)
  })

  it('retains a completed cold batch before a regressed finality refresh', async () => {
    const notes = Array.from({ length: 32 }, (_, index) => note(index))
    let reads = 0
    rpc.call.mockImplementation(async () => {
      if (++reads === 16) final = 99
      return PROXY.encodeFunctionResult('nullifiers', [false])
    })
    await expect(verify(notes)).rejects.toThrow('head moved backwards')
    final = 100; rpc.call.mockClear()
    await verify(notes)
    expect(rpc.call).toHaveBeenCalledTimes(16)
  })

  it('keeps an individual RPC deadline without a whole-history deadline', async () => {
    vi.useFakeTimers()
    rpc.call.mockImplementation(() => new Promise(() => {}))
    const pending = expect(verify()).rejects.toThrow('RPC timed out')
    await vi.advanceTimersByTimeAsync(10_001); await pending
  })
})
