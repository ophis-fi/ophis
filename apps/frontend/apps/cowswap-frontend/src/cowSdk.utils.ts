import { getRpcProvider } from '@cowprotocol/common-const'
import { getProviderErrorMessage, withTimeout } from '@cowprotocol/common-utils'
import { JsonRpcProvider } from '@ethersproject/providers'

/**
 * Read-only JSON-RPC methods the SDK adapter issues. Writes and signing never
 * fall back, and neither do the chain-identity methods (eth_chainId,
 * net_version): the app RPC is picked from the chain the wallet reported, so
 * answering identity from it would let stale React state mask a network switch.
 */
const READ_METHODS = new Set([
  'eth_call',
  'eth_getCode',
  'eth_getBalance',
  'eth_getStorageAt',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_feeHistory',
  'eth_maxPriorityFeePerGas',
])

/** A wallet read that has not answered by then is treated as failed and retried on the app RPC. */
export const WALLET_READ_TIMEOUT_MS = 10_000

const EXECUTION_ERROR_RE = /revert|execution|insufficient funds|gas required exceeds|intrinsic gas|nonce/i

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

/**
 * An error the wallet's node produced by EXECUTING the request (a revert, a
 * failed gas estimation, insufficient funds) is an answer about the wallet's
 * chain state and must surface as is; only transport failures (dead endpoint,
 * rate limit, blocked extension, timeout) justify asking the app RPC instead.
 * Every nesting level a known wrapper can add is inspected.
 */
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

/**
 * The wallet's provider first, so reads reflect whatever chain state the wallet
 * sees (a fork, a private RPC); the app's keyed RPC only when the wallet's RPC
 * fails or stalls on a read. Writes, signing and chain identity always stay on
 * the wallet.
 *
 * Without the fallback a wallet whose RPC is down (a custom URL that died, or
 * the extension blocked by an RPC domain allowlist) took every bridge quote
 * down with it: signing the CoW Shed hook reads the account code before any
 * quote API is called, and the trade form only showed "Error loading price".
 * Same-chain swaps are API-only and kept working, which made it look like a
 * bridge bug.
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
      if (isExecutionError(error)) throw error
      // The app RPC was chosen for the chain the wallet reported when this
      // wrapper was built; mid-switch that is stale. Wallets answer eth_chainId
      // locally, so a live mismatch (or no answer) fails closed on the wallet error.
      if (!(await this.walletStillOnChain())) throw error
      return this.appRpc.send(method, params)
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
