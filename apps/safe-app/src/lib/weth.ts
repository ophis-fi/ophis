import { Interface } from 'ethers';
import { WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/cow-sdk';

// Native-ETH sells go through WRAP-IN-BATCH, not CoW eth-flow. A Safe can batch txs, so it wraps
// its own native ETH to WETH (WETH.deposit{value}) and then sells WETH as a normal ERC-20 order in
// the SAME Safe execution. The order's owner stays the Safe, so the owner-scoped rebate indexer
// (which fetches /trades?owner=<safe>) still sees it and the rebate attributes exactly as for any
// ERC-20 swap. eth-flow would instead make the order owner the eth-flow CONTRACT — which the indexer
// never fetches — so the Ophis fee would still be taken but the trader's rebate silently lost.
export const WETH_DEPOSIT_IFACE = new Interface(['function deposit() payable']);

/**
 * The wrapped-native token address (WETH/WMATIC/WXDAI/…) for `chainId`, from cow-sdk's canonical
 * map. Throws a clear error if the chain has no known wrapped-native token (native-ETH wrapping is
 * then unavailable there; ERC-20 swaps are unaffected).
 */
export function getWethAddress(chainId: number): string {
  const weth = (WRAPPED_NATIVE_CURRENCIES as Record<number, string>)[chainId];
  if (!weth) {
    throw new Error(`Native-ETH selling is unavailable on chain ${chainId} (no known wrapped-native token).`);
  }
  return weth;
}
