import { getRpcProvider } from '@cowprotocol/common-const'
import { JsonRpcProvider } from '@ethersproject/providers'

/** Read-only JSON-RPC methods the SDK adapter issues; writes and signing never fall back. */
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
  'eth_chainId',
  'net_version',
])

/**
 * The wallet's provider first, so reads reflect whatever chain state the wallet
 * sees (a fork, a private RPC); the app's keyed RPC only when the wallet's RPC
 * fails a read. Writes and signing always stay on the wallet.
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
  ) {
    super(undefined, chainId)
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    try {
      return await this.wallet.send(method, params)
    } catch (error) {
      if (!READ_METHODS.has(method)) throw error
      return this.appRpc.send(method, params)
    }
  }
}

/** The wallet provider itself where the app has no RPC for the wallet's chain. */
export function withAppRpcFallback(chainId: number | undefined, wallet: JsonRpcProvider): JsonRpcProvider {
  const appRpc = chainId !== undefined ? getRpcProvider(chainId) : null
  return appRpc && chainId !== undefined ? new WalletFirstReadProvider(wallet, appRpc, chainId) : wallet
}
