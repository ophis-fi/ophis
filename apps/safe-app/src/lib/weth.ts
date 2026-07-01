import { Interface } from 'ethers';
import { WRAPPED_NATIVE_CURRENCIES } from '@cowprotocol/cow-sdk';

// Native-ETH sells go through WRAP-IN-BATCH, not CoW eth-flow. A Safe can batch txs, so it wraps
// its own native ETH to WETH (WETH.deposit{value}) and then sells WETH as a normal ERC-20 order in
// the SAME Safe execution. The order's owner stays the Safe, so the owner-scoped rebate indexer
// (which fetches /trades?owner=<safe>) sees it and the rebate attributes on EVERY chain, exactly as
// for any ERC-20 swap. eth-flow would instead make the order owner the eth-flow CONTRACT: the indexer
// only credits that where Ophis runs its OWN eth-flow contract and scans it (OP only today — it
// re-attributes to order.receiver); on the hosted chains the SHARED CoW eth-flow contract is not
// scanned, so the Ophis fee is still taken but the trader's rebate is lost. A Safe can batch, so it
// never needs eth-flow.
export const WETH_DEPOSIT_IFACE = new Interface(['function deposit() payable']);

// Ophis-operated chains that cow-sdk's WRAPPED_NATIVE_CURRENCIES does not map (it tracks CoW's
// supported set). Unichain (130) is an OP-Stack rollup whose canonical WETH is the 0x4200…0006
// predeploy (the same address the autopilot/EthFlow native-token config and the frontend use).
const OPHIS_WRAPPED_NATIVE: Record<number, string> = {
  130: '0x4200000000000000000000000000000000000006', // Unichain WETH (OP-Stack predeploy)
};

/**
 * The wrapped-native token address (WETH/WMATIC/WXDAI/…) for `chainId`. Checks the Ophis-operated
 * override first (chains cow-sdk does not map), then cow-sdk's canonical map. Throws a clear error if
 * the chain has no known wrapped-native token (native-ETH wrapping is then unavailable there; ERC-20
 * swaps are unaffected).
 */
export function getWethAddress(chainId: number): string {
  const weth = OPHIS_WRAPPED_NATIVE[chainId] ?? (WRAPPED_NATIVE_CURRENCIES as Record<number, string>)[chainId];
  if (!weth) {
    throw new Error(`Native-ETH selling is unavailable on chain ${chainId} (no known wrapped-native token).`);
  }
  return weth;
}
