import { RAILGUN_PROXIES } from './rpc-policy'

export const BASE_HISTORY = {
  chainId: 8453, address: RAILGUN_PROXIES[8453], fromBlock: 50_224_711,
  width: 100_000, maxPages: 1_024, maxLogs: 100_000, maxBytes: 64 * 1024 ** 2,
  pageBytes: 512 * 1024, maxTail: 100_000, refreshMs: 30 * 60_000,
} as const
export const BASE_HISTORY_PATH = '/rpc/history/base'

export function baseHistoryOrigin(origin = 'https://swap.ophis.fi', allowLoopback = false): string {
  const url = new URL(origin)
  historyAssert(url.origin === 'https://swap.ophis.fi' || allowLoopback && url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Untrusted Base history origin.')
  historyAssert(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Invalid Base history origin.')
  return url.origin
}
export interface HistoryLog {
  address: string; blockNumber: string; blockHash: string; transactionHash: string
  transactionIndex: string; logIndex: string; topics: string[]; data: string; removed: false
}
export interface HistoryPage {
  fromBlock: number; toBlock: number; hash: string; bytes: number; count: number
}
export interface HistoryManifest {
  version: 1; chainId: 8453; address: string; fromBlock: number; toBlock: number
  blockHash: string; timestamp: number; pages: HistoryPage[]; generation: string
}
export interface HistoryTail {
  generation: string; fromBlock: number; toBlock: number; blockHash: string; timestamp: number; logs: HistoryLog[]
}
export function historyAssert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
export function historyQuantity(value: unknown): number {
  historyAssert(typeof value === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value), 'Invalid public history quantity.')
  const number = Number(BigInt(value))
  historyAssert(Number.isSafeInteger(number) && number >= 0, 'Invalid public history quantity.')
  return number
}
export function historyHash(value: unknown): value is string { return typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value) }
export async function historyDigest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function historyJSON(response: Response, maximum: number): Promise<{ text: string; value: unknown }> {
  historyAssert(response.ok && response.body, 'Public history is unavailable.')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      historyAssert(bytes <= maximum, 'Public history response is too large.')
      chunks.push(part.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
  return { text, value: JSON.parse(text) }
}
export function validateHistoryLogs(value: unknown, fromBlock: number, toBlock: number): HistoryLog[] {
  historyAssert(Array.isArray(value) && value.length <= BASE_HISTORY.maxLogs, 'Invalid public history log count.')
  const seen = new Set<string>(), blocks = new Map<number, string>()
  return value.map((input: unknown): HistoryLog => {
    historyAssert(input && typeof input === 'object', 'Invalid public history log.')
    const log = input as Record<string, unknown>
    const block = historyQuantity(log.blockNumber), index = historyQuantity(log.logIndex)
    historyQuantity(log.transactionIndex)
    historyAssert(typeof log.address === 'string' && log.address.toLowerCase() === BASE_HISTORY.address &&
      block >= fromBlock && block <= toBlock && log.removed === false && historyHash(log.blockHash) && historyHash(log.transactionHash) &&
      typeof log.data === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(log.data) && Array.isArray(log.topics) &&
      log.topics.length > 0 && log.topics.length <= 4 && log.topics.every(historyHash), 'Invalid public history log metadata.')
    const identity = `${block}:${index}`
    historyAssert(!seen.has(identity), 'Duplicate public history log.')
    historyAssert(!blocks.has(block) || blocks.get(block) === log.blockHash.toLowerCase(), 'Conflicting public history block hashes.')
    seen.add(identity); blocks.set(block, log.blockHash.toLowerCase())
    return { address: BASE_HISTORY.address, blockNumber: log.blockNumber as string, blockHash: log.blockHash.toLowerCase(),
      transactionHash: log.transactionHash.toLowerCase(), transactionIndex: log.transactionIndex as string,
      logIndex: log.logIndex as string, topics: (log.topics as string[]).map(topic => topic.toLowerCase()), data: log.data, removed: false }
  }).sort((a, b) => historyQuantity(a.blockNumber) - historyQuantity(b.blockNumber) || historyQuantity(a.logIndex) - historyQuantity(b.logIndex))
}
export async function validateHistoryManifest(value: unknown): Promise<HistoryManifest> {
  historyAssert(value && typeof value === 'object', 'Invalid public history manifest.')
  const m = value as HistoryManifest
  historyAssert(m.version === 1 && m.chainId === BASE_HISTORY.chainId && m.address === BASE_HISTORY.address &&
    m.fromBlock === BASE_HISTORY.fromBlock && Number.isSafeInteger(m.toBlock) && m.toBlock >= m.fromBlock &&
    historyHash(m.blockHash) && Number.isSafeInteger(m.timestamp) && m.timestamp > 0 &&
    Array.isArray(m.pages) && m.pages.length > 0 && m.pages.length <= BASE_HISTORY.maxPages, 'Invalid public history manifest.')
  let next = m.fromBlock, bytes = 0, count = 0
  for (const page of m.pages) {
    historyAssert(page && page.fromBlock === next && page.toBlock === Math.min(m.toBlock, next + BASE_HISTORY.width - 1) &&
      /^[0-9a-f]{64}$/.test(page.hash) && Number.isSafeInteger(page.bytes) && page.bytes > 0 && page.bytes <= BASE_HISTORY.pageBytes &&
      Number.isSafeInteger(page.count) && page.count >= 0, 'Invalid public history page coverage.')
    next = page.toBlock + 1; bytes += page.bytes; count += page.count
  }
  historyAssert(next === m.toBlock + 1 && bytes <= BASE_HISTORY.maxBytes && count <= BASE_HISTORY.maxLogs, 'Incomplete public history coverage.')
  const { generation, ...core } = m
  historyAssert(typeof generation === 'string' && /^[0-9a-f]{64}$/.test(generation) && await historyDigest(JSON.stringify(core)) === generation,
    'Public history manifest digest differs.')
  return m
}
