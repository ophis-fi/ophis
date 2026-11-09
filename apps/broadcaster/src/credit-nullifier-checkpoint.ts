import { getAddress, isHexString, type JsonRpcProvider } from 'ethers'
import { NETWORK } from './config'
import { PROXY } from './transaction'
import { pooledCreditReads } from './credit-read-pool'

export interface BackingNote {
  key: string; tree: number; nullifier: string; blockNumber: number; blockHash: string
}
interface Head { number: number; hash: string; timestamp: number }
interface Checkpoint { head: Head; keys: Set<string> }
const checkpoints = new WeakMap<JsonRpcProvider, Checkpoint>()
const event = PROXY.getEvent('Nullified')!, topic = event.topicHash

/** A slow cold scan must finish; only individual RPC calls have a deadline. */
export async function backingRead<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Canonical backing RPC timed out.')), 10_000)
    })])
  } finally { clearTimeout(timer) }
}
async function head(provider: JsonRpcProvider, tag: number | 'latest' | 'finalized'): Promise<Head> {
  const value = await backingRead(provider.getBlock(tag))
  if (!value || !isHexString(value.hash, 32) || !Number.isSafeInteger(value.number) || value.number < 0 ||
    !Number.isSafeInteger(value.timestamp) || value.timestamp < 0 || (typeof tag === 'number' && value.number !== tag))
    throw new Error('Canonical finalized backing head is unavailable.')
  return { number: value.number, hash: value.hash!.toLowerCase(), timestamp: value.timestamp }
}
async function unchanged(provider: JsonRpcProvider, expected: Head): Promise<void> {
  if ((await head(provider, expected.number)).hash !== expected.hash) {
    const saved = checkpoints.get(provider)
    if (saved && expected.number <= saved.head.number) checkpoints.delete(provider)
    throw new Error('The backing verification head changed.')
  }
}

/** Trusted read RPC must return complete eth_getLogs results, just as it must return truthful eth_call state. */
async function catchUp(provider: JsonRpcProvider, start: Head, end: Head, owned: ReadonlySet<string>): Promise<void> {
  if (end.number < start.number) throw new Error('The finalized backing head moved backwards.')
  await unchanged(provider, start); await unchanged(provider, end)
  const range = async (fromBlock: number, toBlock: number): Promise<void> => {
    const logs = await backingRead(provider.getLogs({ address: NETWORK.proxyContract, topics: [topic], fromBlock, toBlock }))
    if (!Array.isArray(logs)) throw new Error('Canonical nullifier logs are unavailable.')
    // Split dense ranges; never silently truncate a response or forget an existing liability.
    const bytes = logs.reduce((sum, log) => sum + (typeof log?.data === 'string' ? log.data.length : 0), 0)
    if (logs.length > 4096 || bytes > 8 * 1024 * 1024) {
      if (fromBlock === toBlock) throw new Error('Canonical nullifier block exceeds its response bound.')
      const middle = Math.floor((fromBlock + toBlock) / 2)
      await range(fromBlock, middle); await range(middle + 1, toBlock); return
    }
    let previousBlock = -1, previousIndex = -1, previousTransaction = -1
    const blocks = new Map<number, string>()
    for (const log of logs) {
      if (!log || log.removed !== false || getAddress(log.address) !== getAddress(NETWORK.proxyContract) ||
        !Number.isSafeInteger(log.blockNumber) || log.blockNumber < fromBlock || log.blockNumber > toBlock ||
        !Number.isSafeInteger(log.index) || log.index < 0 || !Number.isSafeInteger(log.transactionIndex) || log.transactionIndex < 0 ||
        !isHexString(log.transactionHash, 32) || !isHexString(log.blockHash, 32) ||
        !isHexString(log.data) || log.data.length > 131_202 || !Array.isArray(log.topics) || log.topics.length !== 1 ||
        log.topics[0]?.toLowerCase() !== topic.toLowerCase() || log.blockNumber < previousBlock ||
        (log.blockNumber === previousBlock && (log.index <= previousIndex || log.transactionIndex < previousTransaction)))
        throw new Error('Malformed canonical nullifier log evidence.')
      previousBlock = log.blockNumber; previousIndex = log.index; previousTransaction = log.transactionIndex
      const priorHash = blocks.get(log.blockNumber)
      if (priorHash && priorHash !== log.blockHash.toLowerCase()) throw new Error('Conflicting canonical nullifier blocks.')
      blocks.set(log.blockNumber, log.blockHash.toLowerCase())
      const decoded = PROXY.decodeEventLog(event, log.data, log.topics)
      const encoded = PROXY.encodeEventLog(event, decoded)
      if (encoded.data.toLowerCase() !== log.data.toLowerCase() || decoded.nullifier.length < 1 || decoded.nullifier.length > 1024)
        throw new Error('Unbounded or noncanonical nullifier event.')
      const unique = new Set<string>()
      for (const nullifier of decoded.nullifier) {
        const identity = `${decoded.treeNumber}:${String(nullifier).toLowerCase()}`
        if (unique.has(identity)) throw new Error('Duplicate canonical nullifier event.')
        unique.add(identity)
        if (owned.has(identity)) throw new Error('An owner spend is missing from synchronized fee history.')
      }
    }
    await pooledCreditReads([...blocks], async ([number, hash]) => {
      if ((await head(provider, number)).hash !== hash) throw new Error('Canonical nullifier history was reorganized.')
    })
  }
  for (let from = start.number + 1; from <= end.number; from += 64) await range(from, Math.min(from + 63, end.number))
  await unchanged(provider, start); await unchanged(provider, end)
}

/** Finalized checkpoints are process-local hints, never durable authority or an exception to canonical checks. */
export async function unspentBackingHead(provider: JsonRpcProvider, notes: readonly BackingNote[], anchor: Head): Promise<Head> {
  let prior = checkpoints.get(provider)
  if (prior) {
    if ((await head(provider, prior.head.number)).hash !== prior.head.hash) { checkpoints.delete(provider); prior = undefined }
    else if (prior.head.number > anchor.number) throw new Error('The finalized backing head regressed; retry its canonical read.')
  }
  const owned = new Set(notes.map((note) => `${note.tree}:${note.nullifier}`))
  if (owned.size !== notes.length) throw new Error('Duplicate accounted input nullifier.')
  const keys = new Set(notes.map((note) => note.key)), origins = new Map<number, Promise<Head>>()
  if (keys.size !== notes.length) throw new Error('Duplicate accounted backing identity.')
  if (prior) await catchUp(provider, prior.head, anchor, owned)
  const verified = new Set([...keys].filter((key) => prior?.keys.has(key)))
  const pending = notes.filter((note) => !verified.has(note.key))
  let cursor = anchor
  const advance = async () => {
    const finalized = await head(provider, 'finalized')
    await catchUp(provider, cursor, finalized, owned)
    // Only completed mappings are reusable. Evict removed keys, and retain progress after later RPC outages.
    checkpoints.set(provider, { head: finalized, keys: new Set(verified) }); cursor = finalized
  }
  for (let offset = 0; offset < pending.length; offset += 16) {
    const batch = pending.slice(offset, offset + 16)
    await pooledCreditReads(batch, async (note) => {
      let origin = origins.get(note.blockNumber)
      if (!origin) { origin = head(provider, note.blockNumber); origins.set(note.blockNumber, origin) }
      if ((await origin).hash !== note.blockHash.toLowerCase()) throw new Error('Accounted fee-note history was reorganized.')
      const result = await backingRead(provider.call({ to: NETWORK.proxyContract,
        data: PROXY.encodeFunctionData('nullifiers', [note.tree, note.nullifier]), blockTag: cursor.number }))
      if (PROXY.decodeFunctionResult('nullifiers', result)[0] !== false)
        throw new Error('An owner spend is missing from synchronized fee history.')
    })
    await unchanged(provider, cursor)
    for (const note of batch) verified.add(note.key)
    checkpoints.set(provider, { head: cursor, keys: new Set(verified) })
    // Re-anchor between bounded batches: a large cold scan does not require archive state retention.
    await advance()
  }
  if (!pending.length) await advance()
  const finalized = cursor
  for (;;) {
    const latest = await head(provider, 'latest')
    await catchUp(provider, cursor, latest, owned)
    await unchanged(provider, finalized)
    if (Math.abs(Date.now() / 1000 - latest.timestamp) <= 45) return latest
    // Preserve completed catch-up work if the head aged while reading a long range.
    if (latest.number === cursor.number) throw new Error('Fresh canonical backing head is unavailable.')
    cursor = latest
  }
}

export const finalizedBackingHead = (provider: JsonRpcProvider): Promise<Head> => head(provider, 'finalized')
