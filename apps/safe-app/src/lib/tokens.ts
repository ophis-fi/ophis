import { isAddressLike, isZeroAddress } from '@ophis/sdk';

// EIP-7528 native-asset sentinel (== cow-sdk's ETH_ADDRESS), inlined (the SDK keeps it private).
// Native-ETH SELLS are supported via wrap-in-batch (weth.ts + submit.ts): the form maps a native
// sell token to WETH BEFORE quoting, so the raw ERC-20 paths below never see the sentinel.
// assertErc20Token therefore still REJECTS the sentinel/zero/malformed — it guards the genuine
// ERC-20 paths (the BUY token, and order.sellToken at the approval, which is WETH after the wrap),
// turning a stray native/zero address into a clear error instead of an unsettleable order.
const NATIVE_TOKEN_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/**
 * Throw a clear error unless `addr` is a usable ERC-20 token address — i.e. well-formed, not the
 * zero address, and not the native-ETH sentinel. `label` names the field for the message.
 */
export function assertErc20Token(addr: string, label: string): void {
  if (!isAddressLike(addr)) throw new Error(`${label} is not a valid token address.`);
  if (isZeroAddress(addr)) throw new Error(`${label} cannot be the zero address.`);
  if (addr.toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase()) {
    throw new Error(`Native ETH is not supported by this app (${label}). Use WETH instead.`);
  }
}

/** True if `addr` is the native-asset sentinel — i.e. the user means native ETH (to be wrapped to WETH). */
export function isNativeEth(addr: string): boolean {
  return addr.trim().toLowerCase() === NATIVE_TOKEN_SENTINEL.toLowerCase();
}
