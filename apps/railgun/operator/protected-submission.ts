export const PROTECTED_WRITE_RPC = 'https://rpc.flashbots.net?hint=hash'
export const BNB_BUNDLE_RPC = 'https://puissant-builder.48.club/'
export const BNB_HEAD_MAX_AGE_SECONDS = 3

export function protectedWriteRPC(chainId = 1): string {
  if (chainId === 1) return PROTECTED_WRITE_RPC
  // The separate signing/qualification gate remains required for this candidate transport.
  if (chainId === 56) return BNB_BUNDLE_RPC
  throw new Error('This chain has no qualified protected submission policy; publication remains disabled.')
}

function serializeBundle(raw: string, maxBlockNumber: number, maxTimestamp: number): string {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendBundle', params: [{
    txs: [raw], maxBlockNumber, maxTimestamp, revertingTxHashes: [], noMerge: true,
  }] })
}

export function assertBnbHead(head: { number: number; timestamp: number }): void {
  if (!Number.isSafeInteger(head.number) || head.number < 0 || head.number > Number.MAX_SAFE_INTEGER - 20 ||
    !Number.isSafeInteger(head.timestamp) || head.timestamp < 0 || Math.abs(Date.now() / 1000 - head.timestamp) > BNB_HEAD_MAX_AGE_SECONDS)
    throw new Error('A fresh, valid trusted BNB head is required before preparing a bundle.')
}

export function createBnbBundle(raw: string, head: { number: number; timestamp: number }, validUntilMs?: number): string {
  assertBnbHead(head)
  if (validUntilMs !== undefined && (!Number.isSafeInteger(validUntilMs) || validUntilMs <= Date.now()))
    throw new Error('The authenticated BNB fee expiration is invalid or expired.')
  const maxTimestamp = Math.min(Math.floor(Date.now() / 1000) + 30, head.timestamp + 30, Math.floor((validUntilMs ?? Infinity) / 1000))
  if (maxTimestamp <= Date.now() / 1000) throw new Error('The authenticated BNB fee expires before publication.')
  return serializeBundle(raw, head.number + 20, maxTimestamp)
}

/** Exact canonical policy, including an empty revert allowlist; no caller-supplied extras. */
export function readBnbBundle(body: string, expectedRaw?: string): { raw: string; maxBlockNumber: number; maxTimestamp: number } {
  try {
    const request = JSON.parse(body), bundle = request.params[0]
    const raw = bundle.txs[0], { maxBlockNumber, maxTimestamp } = bundle
    if (typeof raw !== 'string' || (expectedRaw !== undefined && raw.toLowerCase() !== expectedRaw.toLowerCase()) ||
      !Number.isSafeInteger(maxBlockNumber) || maxBlockNumber < 20 ||
      !Number.isSafeInteger(maxTimestamp) || maxTimestamp < 30 || body !== serializeBundle(raw, maxBlockNumber, maxTimestamp)) throw new Error()
    return { raw, maxBlockNumber, maxTimestamp }
  } catch { throw new Error('The journaled BNB bundle envelope is invalid; preserve its signed record.') }
}

export function assertBnbBundleUnexpired(body: string, raw: string, height: bigint): void {
  const bundle = readBnbBundle(body, raw)
  if (height >= BigInt(bundle.maxBlockNumber) || Date.now() / 1000 >= bundle.maxTimestamp)
    throw new Error('The journaled BNB bundle expired. Its signed bytes and nonce remain held; reconcile or explicitly cancel. Expiry was not extended.')
}

/** Returns only the builder acknowledgment, never a transaction receipt/hash substitute. */
export async function submitProtected(chainId: number, body: string, transactionHash: string): Promise<string | undefined> {
  try {
    const response = await fetch(protectedWriteRPC(chainId), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(15_000), body })
    const result = await response.json() as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
    if (!response.ok || result.jsonrpc !== '2.0' || result.id !== 1 || result.error ||
      (chainId === 56 ? typeof result.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(result.result)
        : result.result !== transactionHash)) throw new Error()
    return chainId === 56 ? result.result as string : undefined
  } catch {
    // Rejections, duplicates and timeouts may follow acceptance. Never expose upstream diagnostics.
    throw new Error('Protected submission was not acknowledged. Its outcome is unknown; the signed transaction remains journaled. No public fallback was attempted.')
  }
}
