import { FetchRequest, getAddress, isHexString, JsonRpcProvider } from 'ethers'

export function traceRpcURL(value: string | undefined, chainId: number, mode: 'mainnet' | 'fork'): string | undefined {
  if (value === undefined) return
  try {
    const url = new URL(value), local = ['127.0.0.1', '[::1]'].includes(url.hostname)
    if (chainId !== 56 || url.username || url.password || url.hash ||
      (mode === 'fork' ? !local || url.protocol !== 'http:' : local || url.hostname === 'localhost' || url.protocol !== 'https:'))
      throw new Error()
    return url.href
  } catch { throw new Error('The optional BNB trace RPC requires HTTPS on mainnet or a loopback HTTP fork endpoint.') }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid canonical RPC quantity.')
  return BigInt(value).toString()
}
function block(value: unknown, number: string): string {
  if (!object(value) || quantity(value.number) !== quantity(number) || !isHexString(value.hash, 32))
    throw new Error('Canonical trace block is unavailable.')
  return String(value.hash).toLowerCase()
}
function receipt(value: unknown, hash: string) {
  if (!object(value) || !isHexString(value.transactionHash, 32) || String(value.transactionHash).toLowerCase() !== hash ||
    !isHexString(value.blockHash, 32) || !['0', '1'].includes(quantity(value.status)) || BigInt(quantity(value.gasUsed)) <= 0n ||
    typeof value.from !== 'string' || (value.to !== null && typeof value.to !== 'string')) throw new Error('Canonical trace receipt is unavailable.')
  const number = quantity(value.blockNumber), gas = quantity(value.gasUsed), cumulative = quantity(value.cumulativeGasUsed)
  if (BigInt(cumulative) < BigInt(gas)) throw new Error('Inconsistent canonical trace gas.')
  return { number: `0x${BigInt(number).toString(16)}`, blockHash: String(value.blockHash).toLowerCase(),
    identity: JSON.stringify([hash, String(value.blockHash).toLowerCase(), number, quantity(value.status), getAddress(value.from),
      value.to === null ? null : getAddress(value.to), gas, cumulative, quantity(value.effectiveGasPrice), quantity(value.transactionIndex)]) }
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Bound BNB trace RPC timed out.')), 10_000)
  })]) } finally { clearTimeout(timer) }
}
function options(value: unknown): void {
  if (!object(value) || value.tracer !== 'callTracer' || value.timeout !== '10s' ||
    Object.keys(value).some((key) => !['tracer', 'timeout', 'tracerConfig'].includes(key)))
    throw new Error('Only bounded callTracer requests are supported.')
  if (value.tracerConfig !== undefined && (!object(value.tracerConfig) ||
    Object.entries(value.tracerConfig).some(([key, enabled]) => !['onlyTopCall', 'withLog'].includes(key) || enabled !== false)))
    throw new Error('Trace overrides are unsupported.')
}
function callRoot(trace: Record<string, unknown>, call: Record<string, unknown>): void {
  const data = call.data ?? call.input ?? '0x'
  if (trace.type !== 'CALL' || typeof call.from !== 'string' || typeof call.to !== 'string' ||
    typeof trace.from !== 'string' || typeof trace.to !== 'string' || !isHexString(data) || !isHexString(trace.input) ||
    (call.input !== undefined && call.data !== undefined && call.input !== call.data) ||
    getAddress(trace.from) !== getAddress(call.from) || getAddress(trace.to) !== getAddress(call.to) ||
    String(trace.input).toLowerCase() !== String(data).toLowerCase() || quantity(trace.value) !== quantity(call.value ?? '0x0'))
    throw new Error('Trace root does not match the simulated call.')
}

/** Only tracing uses the secondary. All state, headers and transaction submission retain their original provider. */
export class BNBTraceProvider extends JsonRpcProvider {
  private readonly traceProvider: JsonRpcProvider
  constructor(primary: string, secondary: string, mode: 'mainnet' | 'fork' = 'mainnet') {
    super(primary, 56, { batchMaxCount: 1, cacheTimeout: -1 })
    const request = new FetchRequest(traceRpcURL(secondary, 56, mode)!)
    request.timeout = 10_000
    this.traceProvider = new JsonRpcProvider(request, 56, { batchMaxCount: 1, cacheTimeout: -1, staticNetwork: true })
  }
  private async matchingChains(): Promise<void> {
    const chains = await Promise.all([bounded(super.send('eth_chainId', [])), bounded(this.traceProvider.send('eth_chainId', []))])
    if (chains.some((chain) => quantity(chain) !== '56')) throw new Error('Trace RPC chain mismatch.')
  }
  private async callBlock(tag: string): Promise<string> {
    const blocks = await Promise.all([bounded(super.send('eth_getBlockByNumber', [tag, false])),
      bounded(this.traceProvider.send('eth_getBlockByNumber', [tag, false]))])
    const primary = block(blocks[0], tag)
    if (block(blocks[1], tag) !== primary) throw new Error('Trace RPC block mismatch.')
    return primary
  }
  private async transactionReceipt(hash: string): Promise<string> {
    const receipts = await Promise.all([bounded(super.send('eth_getTransactionReceipt', [hash])),
      bounded(this.traceProvider.send('eth_getTransactionReceipt', [hash]))])
    const primary = receipt(receipts[0], hash), secondary = receipt(receipts[1], hash)
    if (primary.identity !== secondary.identity ||
      block(await bounded(super.send('eth_getBlockByNumber', [primary.number, false])), primary.number) !== primary.blockHash)
      throw new Error('Trace RPC receipt or primary canonical block mismatch.')
    return primary.identity
  }
  override async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    if (method !== 'debug_traceCall' && method !== 'debug_traceTransaction') return super.send(method, params)
    try {
      params = JSON.parse(JSON.stringify(params)) // Pin the request across asynchronous canonical checks.
      if (!Array.isArray(params)) throw new Error('Trace arguments are unsupported.')
      options(params[params.length - 1])
      const call = method === 'debug_traceCall'
      if (call ? params.length !== 3 || !object(params[0]) || typeof params[1] !== 'string'
        : params.length !== 2 || !isHexString(params[0], 32)) throw new Error('Trace arguments are unsupported.')
      const key = call ? params[1] as string : String(params[0]).toLowerCase()
      if (call) quantity(key) // No implicit latest/pending state or caller-supplied state overrides.
      await this.matchingChains()
      const before = await (call ? this.callBlock(key) : this.transactionReceipt(key))
      const result: unknown = await bounded(this.traceProvider.send(method, params))
      await this.matchingChains()
      if (await (call ? this.callBlock(key) : this.transactionReceipt(key)) !== before)
        throw new Error('Canonical trace evidence changed during execution.')
      if (!object(result)) throw new Error('Trace response is unavailable.')
      if (call) callRoot(result, params[0])
      return result
    } catch { throw new Error('Bound BNB trace unavailable or canonical evidence changed.') }
  }
  override destroy(): void { this.traceProvider.destroy(); super.destroy() }
}
