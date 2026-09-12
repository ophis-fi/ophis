import { getRpcProvider } from '@cowprotocol/common-const'
import type { JsonRpcProvider } from '@ethersproject/providers'

/**
 * Which provider the SDK adapter reads chain state from once a wallet is
 * connected: the app's keyed RPC for the wallet's chain, the wallet's own
 * provider only for chains the app has no RPC for. The wallet stays the signer
 * either way.
 *
 * Reads used to go through the wallet, so a wallet whose RPC fails (a custom
 * URL that is down, or the extension blocked by an RPC domain allowlist) took
 * every bridge quote down with it: signing the CoW Shed hook reads the account
 * code and estimates gas before any quote API is called, and the trade form
 * only showed "Error loading price". Same-chain swaps are API-only and kept
 * working, which made the failure look like a bridge bug.
 */
export function pickSdkReadProvider<T extends JsonRpcProvider>(
  chainId: number | undefined,
  walletProvider: T,
): JsonRpcProvider {
  return (chainId !== undefined && getRpcProvider(chainId)) || walletProvider
}
