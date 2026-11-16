import assert from 'node:assert/strict'
import { constants, fstatSync, openSync, readFileSync, closeSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { ABIRailgunSmartWallet, V2Events, type AccumulatedEvents } from '@railgun-community/engine'
import { getAddress, Interface, isHexString } from 'ethers'

export interface HistorySnapshot { chainId: number; address: string; fromBlock: number; toBlock: number; blockHash: string }
const abi = new Interface(ABIRailgunSmartWallet)

/** Test-only public log import. The normal engine must still validate every Merkle root. */
export function decodeBaseHistoryCache(value: unknown, snapshot: HistorySnapshot): AccumulatedEvents {
  const cache = value as Record<string, any>
  assert(snapshot.chainId === 8453 && cache?.version === 1 && cache.chainId === snapshot.chainId &&
    cache.fromBlock === snapshot.fromBlock && cache.toBlock === snapshot.toBlock && cache.blockHash === snapshot.blockHash &&
    getAddress(cache.address) === getAddress(snapshot.address), 'Public history cache differs from its canonical fork snapshot.')
  assert(Array.isArray(cache.logs) && cache.logs.length <= 100_000, 'Public history cache log limit exceeded.')
  const events: AccumulatedEvents = { commitmentEvents: [], nullifierEvents: [], unshieldEvents: [] }
  const seen = new Set<string>(), blocks = new Map<number, string>()
  const logs = cache.logs.map((log: any) => {
    const blockNumber = Number(log.blockNumber), index = Number(log.logIndex)
    assert(getAddress(log.address) === getAddress(snapshot.address) && log.removed === false &&
      Number.isSafeInteger(blockNumber) && blockNumber >= snapshot.fromBlock && blockNumber <= snapshot.toBlock &&
      Number.isSafeInteger(index) && index >= 0 && isHexString(log.blockHash, 32) && isHexString(log.transactionHash, 32) &&
      isHexString(log.data) && Array.isArray(log.topics) && log.topics.length > 0 && log.topics.every((topic: unknown) => isHexString(topic, 32)),
    'Invalid public history log metadata.')
    const identity = `${log.blockHash}:${index}`
    assert(!seen.has(identity), 'Duplicate public history log.')
    assert(!blocks.has(blockNumber) || blocks.get(blockNumber) === log.blockHash, 'Conflicting public history block hashes.')
    seen.add(identity); blocks.set(blockNumber, log.blockHash)
    return { ...log, blockNumber, index }
  }).sort((a: any, b: any) => a.blockNumber - b.blockNumber || a.index - b.index)
  for (const log of logs) {
    const parsed = abi.parseLog(log)
    if (!parsed) continue // Administrative events are also ignored by SDK UTXO scanning.
    // Keep ethers' named tuple/array Results: toObject(true) turns unnamed
    // single-element arrays into {_ : value}, which is not the SDK's ABI shape.
    const args = parsed.args
    if (parsed.name === 'Shield') events.commitmentEvents.push(V2Events.formatShieldEvent(args as never, log.transactionHash,
      log.blockNumber, args.fees, undefined))
    else if (parsed.name === 'Transact') events.commitmentEvents.push(V2Events.formatTransactEvent(args as never,
      log.transactionHash, log.blockNumber, undefined))
    else if (parsed.name === 'Nullified') events.nullifierEvents.push(...V2Events.formatNullifiedEvents(args as never,
      log.transactionHash, log.blockNumber))
    else if (parsed.name === 'Unshield') events.unshieldEvents.push(V2Events.formatUnshieldEvent(args as never,
      log.transactionHash, log.blockNumber, log.index, undefined))
  }
  return events
}

export function readBaseHistoryCache(path: string, snapshot: HistorySnapshot): AccumulatedEvents {
  assert(isAbsolute(path), 'Select an explicit absolute public history cache path.')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    assert(stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0 && stat.size <= 64 * 1024 ** 2,
      'Public history cache must be an owned bounded private file.')
    return decodeBaseHistoryCache(JSON.parse(readFileSync(fd, 'utf8')), snapshot)
  } finally { closeSync(fd) }
}
