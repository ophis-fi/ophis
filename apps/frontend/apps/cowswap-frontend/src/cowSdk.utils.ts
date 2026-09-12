import { getRpcProvider } from '@cowprotocol/common-const'
import { withTimeout } from '@cowprotocol/common-utils'
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
}

/**
 * An error the wallet's node produced by EXECUTING the request (a revert, a
 * failed gas estimation, insufficient funds) is an answer about the wallet's
 * chain state and must surface as is; only transport failures (dead endpoint,
 * rate limit, blocked extension, timeout) justify asking the app RPC instead.
 */
export function isExecutionError(error: unknown): boolean {
  const e = (error ?? {}) as RpcErrorLike
  // MetaMask wraps node errors as -32603 with the original error under data.
  const inner = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as RpcErrorLike
  if (e.code === 3 || inner.code === 3) return true
  if (typeof e.data === 'string' && e.data.startsWith('0x')) return true
  if (typeof inner.data === 'string' && inner.data.startsWith('0x')) return true
  const messages = [e.message, inner.message].filter((m): m is string => typeof m === 'string').join(' ')
  return EXECUTION_ERROR_RE.test(messages)
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
    chainId: number,
    private readonly readTimeoutMs: number = WALLET_READ_TIMEOUT_MS,
  ) {
    super(undefined, chainId)
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    if (!READ_METHODS.has(method)) return this.wallet.send(method, params)
    try {
      return await withTimeout(this.wallet.send(method, params), this.readTimeoutMs, `wallet ${method}`)
    } catch (error) {
      if (isExecutionError(error)) throw error
      return this.appRpc.send(method, params)
    }
  }
}

/** The wallet provider itself where the app has no RPC for the wallet's chain. */
export function withAppRpcFallback(chainId: number | undefined, wallet: JsonRpcProvider): JsonRpcProvider {
  const appRpc = chainId !== undefined ? getRpcProvider(chainId) : null
  return appRpc && chainId !== undefined ? new WalletFirstReadProvider(wallet, appRpc, chainId) : wallet
}
