import { getRpcProvider } from '@cowprotocol/common-const'
import { getProviderErrorMessage, withTimeout } from '@cowprotocol/common-utils'
import { JsonRpcProvider } from '@ethersproject/providers'

/** Read-only methods that may fall back. Writes, signing and chain identity (eth_chainId, net_version) never do. */
const READ_METHODS = new Set(
  'eth_call eth_getCode eth_getBalance eth_getStorageAt eth_blockNumber eth_getBlockByNumber eth_getBlockByHash eth_getTransactionCount eth_getTransactionByHash eth_getTransactionReceipt eth_getLogs eth_estimateGas eth_gasPrice eth_feeHistory eth_maxPriorityFeePerGas'.split(
    ' ',
  ),
)

/** A wallet read that has not answered by then is treated as failed and retried on the app RPC. */
export const WALLET_READ_TIMEOUT_MS = 10_000

/**
 * Node answers produced by running or validating the request against chain
 * state: reverts, VM failures, gas, nonce, balance and EIP-1559 fee checks.
 */
const EXECUTION_ERROR_RE =
  /revert|execution (reverted|failed|error)|vm execution|insufficient (funds|balance)|gas required exceeds|intrinsic gas|nonce|out of gas|invalid opcode|invalid jump|stack (underflow|overflow)|call depth|max code size|contract creation code storage|fee cap|base fee|max fee per gas|priority fee|tip higher|underpriced|exceeds block gas limit|gas limit reached|already known|already imported|sender is not an eoa/i

interface RpcErrorLike {
  code?: unknown
  message?: unknown
  data?: unknown
  error?: unknown
  originalError?: unknown
  cause?: unknown
}

/** Wrappers providers nest the node's answer under: MetaMask (data, data.originalError), ethers (error, cause). */
const NESTED_ERROR_KEYS = ['data', 'error', 'originalError', 'cause'] as const
const MAX_ERROR_DEPTH = 6

/** The wallet's node answered by running the request (revert, gas, funds): an answer about its chain state, surfaced as is. */
function hasExecutionMessage(error: unknown): boolean {
  // WalletConnect-style providers reject with a bare string; getProviderErrorMessage knows that shape.
  const message = getProviderErrorMessage(error)
  return typeof message === 'string' && EXECUTION_ERROR_RE.test(message)
}

function hasExecutionCode(e: RpcErrorLike): boolean {
  return e.code === 3 || (typeof e.data === 'string' && e.data.startsWith('0x'))
}

export function isExecutionError(error: unknown, depth = 0): boolean {
  if (depth > MAX_ERROR_DEPTH || error === null || error === undefined) return false
  if (hasExecutionMessage(error)) return true
  if (typeof error !== 'object') return false
  const e = error as RpcErrorLike
  return hasExecutionCode(e) || NESTED_ERROR_KEYS.some((key) => isExecutionError(e[key], depth + 1))
}

/** JSON-RPC and ethers codes a failing transport produces (MetaMask wraps upstream RPC failures as -32603). */
const TRANSPORT_ERROR_CODES = new Set<unknown>([-32603, -32005, -32002, 'SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR'])
/** EIP-1193 provider errors that are the wallet's own decision, whatever text they carry. */
const WALLET_POLICY_CODES = new Set<unknown>([4001, 4100, 4200, 4900, 4901])
const TRANSPORT_ERROR_RE =
  /timeout|timed out|rate limit|too many requests|limit exceeded|service unavailable|failed to fetch|fetch failed|load failed|network ?(error|request failed)|failed to connect|connection (refused|reset|closed)|enotfound|unreachable|econn|socket hang up|bad gateway|gateway time-?out|forbidden|unauthorized|invalid (api )?key|aborted|abort ?error|unexpected (token|end of json)|invalid json|non-200|internal json-rpc error|\b(401|403|429|500|502|503|504)\b/i
/** Wrappers that carry nothing but the node's answer: judge the answer, not the envelope. */
const GENERIC_WRAPPER_CODES = new Set<unknown>([-32603, 'SERVER_ERROR'])

/** Only a positively identified transport failure (dead or rate-limited endpoint, blocked extension, timeout) may fall back. */
/** A wallet policy code anywhere in the wrapper chain, however the outer layers describe it. */
function hasWalletPolicyCode(error: unknown, depth = 0): boolean {
  if (depth > MAX_ERROR_DEPTH || error === null || typeof error !== 'object') return false
  const e = error as RpcErrorLike
  return WALLET_POLICY_CODES.has(e.code) || NESTED_ERROR_KEYS.some((key) => hasWalletPolicyCode(e[key], depth + 1))
}

/** The node's own answer a wrapper carries: a nested object with a code or message, or a bare string. */
function nodeAnswerOf(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return value.length > 0 ? value : undefined
  if (!value || typeof value !== 'object') return undefined
  if ('code' in value || 'message' in value) return value
  return nestedNodeAnswer(value as RpcErrorLike, depth + 1)
}

function nestedNodeAnswer(e: RpcErrorLike, depth = 0): unknown {
  if (depth > MAX_ERROR_DEPTH) return undefined
  for (const key of NESTED_ERROR_KEYS) {
    const answer = nodeAnswerOf(e[key], depth)
    if (answer !== undefined) return answer
  }
  return undefined
}

function hasTransportMessage(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name // a DOMException AbortError names the failure
  return TRANSPORT_ERROR_RE.test(`${typeof name === 'string' ? name : ''} ${getProviderErrorMessage(error) ?? ''}`)
}

function hasTransportMarker(error: unknown, depth = 0): boolean {
  if (depth > MAX_ERROR_DEPTH || error === null || error === undefined) return false
  const e = (typeof error === 'object' ? error : {}) as RpcErrorLike
  const nested = nestedNodeAnswer(e)
  // A generic envelope (MetaMask -32603, ethers SERVER_ERROR) says nothing itself; the node's answer decides.
  if (nested !== undefined && GENERIC_WRAPPER_CODES.has(e.code)) return hasTransportMarker(nested, depth + 1)
  if (hasTransportMessage(error) || TRANSPORT_ERROR_CODES.has(e.code)) return true
  return NESTED_ERROR_KEYS.some((key) => hasTransportMarker(e[key], depth + 1))
}

export function isTransportError(error: unknown): boolean {
  // The whole chain is scanned for a policy code first: a 4100 nested under a
  // -32603 wrapper or an ethers SERVER_ERROR is still the wallet's answer.
  return !hasWalletPolicyCode(error) && hasTransportMarker(error)
}

/**
 * The wallet's provider first, so reads reflect the chain state the wallet sees
 * (a fork, a private RPC); the app's keyed RPC only when the wallet's RPC fails
 * or stalls on a read at the transport level. Writes, signing, chain identity
 * and the wallet's own policy answers always stay on the wallet. Without this,
 * a wallet whose RPC was down took every bridge quote with it (the CoW Shed hook
 * signing reads the account code before any quote API is called) while
 * same-chain swaps, API-only, kept working.
 */
export class WalletFirstReadProvider extends JsonRpcProvider {
  constructor(
    private readonly wallet: JsonRpcProvider,
    private readonly appRpc: JsonRpcProvider,
    private readonly appRpcChainId: number,
    private readonly readTimeoutMs: number = WALLET_READ_TIMEOUT_MS,
  ) {
    super(undefined, appRpcChainId)
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (!READ_METHODS.has(method)) return this.wallet.send(method, params)
    try {
      return await withTimeout(this.wallet.send(method, params), this.readTimeoutMs, `wallet ${method}`)
    } catch (error) {
      if (isExecutionError(error) || !isTransportError(error)) throw error
      // The app RPC was chosen for the chain the wallet reported when this
      // wrapper was built; mid-switch that is stale. Wallets answer eth_chainId
      // locally, so a live mismatch (or no answer) fails closed on the wallet error.
      if (!(await this.walletStillOnChain())) throw error
      const result = await this.appRpc.send(method, params)
      // A switch that landed while the fallback was in flight makes the answer stale too.
      if (!(await this.walletStillOnChain())) throw error
      return result
    }
  }

  private async walletStillOnChain(): Promise<boolean> {
    try {
      const live = await withTimeout(this.wallet.send('eth_chainId', []), this.readTimeoutMs, 'wallet eth_chainId')
      return Number(live) === this.appRpcChainId
    } catch {
      return false
    }
  }
}

/** The wallet provider itself where the app has no RPC for the wallet's chain. */
export function withAppRpcFallback(chainId: number | undefined, wallet: JsonRpcProvider): JsonRpcProvider {
  const appRpc = chainId !== undefined ? getRpcProvider(chainId) : null
  return appRpc && chainId !== undefined ? new WalletFirstReadProvider(wallet, appRpc, chainId) : wallet
}
