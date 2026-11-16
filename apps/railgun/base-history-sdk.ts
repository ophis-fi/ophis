import { ABIRailgunSmartWallet, V2Events, type AccumulatedEvents, type RailgunEngine } from '@railgun-community/engine'
import { Interface, type JsonRpcProvider } from 'ethers'
import { BASE_HISTORY as B, BASE_HISTORY_PATH, baseHistoryOrigin, historyAssert, historyDigest, historyHash, historyJSON, historyQuantity,
  validateHistoryLogs, validateHistoryManifest, type HistoryLog, type HistoryManifest, type HistoryTail } from './base-history'

// RAILGUN's own proxy administrative events (contract/contracts/proxy/Proxy.sol).
const abi = new Interface([...ABIRailgunSmartWallet, 'event ProxyUpgrade(address previousImplementation, address newImplementation)',
  'event ProxyOwnershipTransfer(address previousOwner, address newOwner)', 'event ProxyPause()', 'event ProxyUnpause()'])
type UTXOMerkletree = ReturnType<RailgunEngine['getUTXOMerkletree']>
const passive = new Set(['Action', 'AddToBlocklist', 'RemoveFromBlocklist', 'FeeChange', 'Initialized',
  'OwnershipTransferred', 'TreasuryChange', 'VerifyingKeySet', 'ProxyUpgrade', 'ProxyOwnershipTransfer', 'ProxyPause', 'ProxyUnpause'])
export interface BaseHistoryCheckpoint { blockNumber: number; blockHash: string }
interface RequiredReceipt extends BaseHistoryCheckpoint { hash: string }
export interface BaseHistoryScan {
  events: AccumulatedEvents
  checkpoint: BaseHistoryCheckpoint
  validate: (tree: UTXOMerkletree) => Promise<void>
}

/** Same SDK formatter as normal V2 UTXO scanning; metadata and empty ranges remain independently checked. */
export function decodeBaseHistory(logs: readonly HistoryLog[]): AccumulatedEvents {
  const events: AccumulatedEvents = { commitmentEvents: [], nullifierEvents: [], unshieldEvents: [] }
  for (const log of logs) {
    const parsed = abi.parseLog(log)
    historyAssert(parsed, 'Unknown Base history event.')
    const args = parsed.args, block = historyQuantity(log.blockNumber)
    if (parsed.name === 'Shield') events.commitmentEvents.push(V2Events.formatShieldEvent(args as never, log.transactionHash, block, args.fees, undefined))
    else if (parsed.name === 'Transact') events.commitmentEvents.push(V2Events.formatTransactEvent(args as never, log.transactionHash, block, undefined))
    else if (parsed.name === 'Nullified') events.nullifierEvents.push(...V2Events.formatNullifiedEvents(args as never, log.transactionHash, block))
    else if (parsed.name === 'Unshield') events.unshieldEvents.push(V2Events.formatUnshieldEvent(args as never, log.transactionHash,
      block, historyQuantity(log.logIndex), undefined))
    // Action reconstructs TXID history, not UTXOs. Ophis's existing PPOI policy is unchanged.
    else historyAssert(passive.has(parsed.name), 'Unsupported Base history event.')
  }
  return events
}

export async function installBaseHistory(engine: RailgunEngine, provider: JsonRpcProvider, origin: string) {
  const source = await createBaseHistorySource(provider, origin)
  engine.setBaseHistorySource(source)
  return source
}

export async function createBaseHistorySource(provider: JsonRpcProvider, origin: string) {
  const url = new URL(baseHistoryOrigin(origin, true))
  let cached: { manifest: HistoryManifest; logs: HistoryLog[] } | undefined
  let required: readonly RequiredReceipt[] = [], covered = ''
  const get = async (path: string, maximum: number) => {
    const response = await fetch(new URL(BASE_HISTORY_PATH + path, url), { redirect: 'error', credentials: 'omit',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) })
    historyAssert(response.status === 200, 'Base history is warming or unavailable. Retry without clearing your wallet.')
    return historyJSON(response, maximum)
  }
  const header = async (number: number) => {
    const value = await provider.send('eth_getBlockByNumber', [`0x${number.toString(16)}`, false]) as Record<string, unknown>
    historyAssert(value && historyHash(value.hash) && historyQuantity(value.number) === number, 'Base canonical history header is unavailable.')
    return value.hash.toLowerCase()
  }
  const snapshot = async () => {
    const manifest = await validateHistoryManifest((await get('/manifest', 512 * 1024)).value)
    if (cached?.manifest.generation === manifest.generation) return cached
    const finalized = await provider.send('eth_getBlockByNumber', ['finalized', false]) as Record<string, unknown>
    historyAssert(finalized && historyHash(finalized.hash) && historyQuantity(finalized.number) >= manifest.toBlock &&
      await header(manifest.toBlock) === manifest.blockHash, 'Base history snapshot is not canonical and finalized.')
    const logs: HistoryLog[] = []
    for (const [index, page] of manifest.pages.entries()) {
      const body = await get(`/page/${manifest.generation}/${index}`, B.pageBytes)
      historyAssert(new TextEncoder().encode(body.text).length === page.bytes && await historyDigest(body.text) === page.hash, 'Base history page digest differs.')
      const values = validateHistoryLogs(body.value, page.fromBlock, page.toBlock)
      historyAssert(values.length === page.count, 'Base history page count differs.')
      logs.push(...values)
    }
    cached = { manifest, logs }
    return cached
  }
  // No provider has been loaded yet: a cold miss cannot trigger the SDK's legacy scan.
  historyAssert((await provider.getNetwork()).chainId === BigInt(B.chainId), 'Base history provider chain differs.')
  await snapshot()
  const source = async (checkpoint?: BaseHistoryCheckpoint): Promise<BaseHistoryScan> => {
    const receipts = required.map(receipt => ({ ...receipt }))
    if (checkpoint && !(Number.isSafeInteger(checkpoint.blockNumber) && checkpoint.blockNumber >= B.fromBlock && historyHash(checkpoint.blockHash) &&
      await header(checkpoint.blockNumber) === checkpoint.blockHash))
      throw Object.assign(new Error('Base history checkpoint changed. Rebuild verified history; preserve wallet keys and saved transactions.'), { requiresBaseHistoryRescan: true })
    const { manifest, logs } = await snapshot()
    const tail = (await get(`/tail/${manifest.generation}`, 8 * 1024 ** 2)).value as HistoryTail
    historyAssert(tail && tail.generation === manifest.generation && tail.fromBlock === manifest.toBlock + 1 &&
      Number.isSafeInteger(tail.toBlock) && tail.toBlock >= manifest.toBlock && tail.toBlock - manifest.toBlock <= B.maxTail &&
      historyHash(tail.blockHash) && Number.isSafeInteger(tail.timestamp) && tail.timestamp >= manifest.timestamp &&
      tail.timestamp <= Date.now() / 1000 + 30 && Date.now() / 1000 - tail.timestamp <= 90 &&
      (!checkpoint || tail.toBlock >= checkpoint.blockNumber), 'Base recent history is not current. Retry shortly.')
    const recent = validateHistoryLogs(tail.logs, tail.fromBlock, tail.toBlock)
    historyAssert(receipts.every(receipt => tail.toBlock >= receipt.blockNumber),
      'Your transaction is mined; Base private history is catching up (about 30 seconds). Keep the saved transaction and refresh balances; do not repeat it.')
    const verifyReceipts = async () => {
      for (const receipt of receipts) historyAssert(await header(receipt.blockNumber) === receipt.blockHash,
        'The saved Base receipt is no longer canonical. Keep the pending transaction and check its status again.')
    }
    await verifyReceipts()
    historyAssert(logs.length + recent.length <= B.maxLogs, 'Base history event limit exceeded.')
    historyAssert(await header(manifest.toBlock) === manifest.blockHash && await header(tail.toBlock) === tail.blockHash,
      'Base history anchor differs from the trusted provider.')
    const at = `0x${tail.toBlock.toString(16)}`
    const [root, treeNumber, nextLeafIndex] = await Promise.all(['merkleRoot', 'treeNumber', 'nextLeafIndex'].map(async name => {
      const result = await provider.send('eth_call', [{ to: B.address, data: abi.encodeFunctionData(name) }, at])
      return abi.decodeFunctionResult(name, result)[0]
    }))
    const tree = Number(treeNumber), length = Number(nextLeafIndex)
    historyAssert(Number.isSafeInteger(tree) && tree >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= 65_536 && historyHash(root),
      'Invalid Base canonical tree state.')
    const fromBlock = checkpoint?.blockNumber ?? B.fromBlock
    const events = decodeBaseHistory([...logs, ...recent].filter(log => historyQuantity(log.blockNumber) >= fromBlock))
    return { events, checkpoint: { blockNumber: tail.toBlock, blockHash: tail.blockHash.toLowerCase() }, validate: async (merkletree) => {
      const latest = await merkletree.getLatestTreeAndIndex()
      const actualRoot = await merkletree.getRoot(tree)
      historyAssert(!merkletree.hasPendingWrites() && merkletree.getFirstInvalidMerklerootTree() == null &&
        (latest.tree === tree || length === 0 && latest.tree === tree - 1 && latest.index === 65_535) &&
        await merkletree.getTreeLength(tree) === length && `0x${actualRoot.replace(/^0x/, '')}`.toLowerCase() === String(root).toLowerCase(),
        'Base history does not match the complete canonical tree.')
      historyAssert(await header(manifest.toBlock) === manifest.blockHash && await header(tail.toBlock) === tail.blockHash,
        'Base history changed during verification.')
      await verifyReceipts()
      covered = JSON.stringify(receipts)
    } }
  }
  return Object.assign(source, {
    setRequiredReceipts(receipts: readonly RequiredReceipt[]) {
      historyAssert(receipts.length <= 16 && receipts.every(receipt => historyHash(receipt.hash) && historyHash(receipt.blockHash) &&
        Number.isSafeInteger(receipt.blockNumber) && receipt.blockNumber >= B.fromBlock), 'Invalid Base confirmation requirement.')
      required = receipts.map(receipt => ({ ...receipt }))
    },
    assertReceiptCoverage() {
      historyAssert(covered === JSON.stringify(required), 'Base private history has not covered the saved confirmation. Keep the saved transaction and refresh balances.')
    },
  })
}
