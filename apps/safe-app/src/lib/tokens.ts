import { isAddressLike, isZeroAddress } from '@ophis/sdk';

// EIP-7528 native-asset sentinel (== cow-sdk's ETH_ADDRESS). This app is ERC-20 only: a
// native-ETH sell needs the on-chain eth-flow path (a separate contract + a value tx), which
// the scaffold does not implement. Without an explicit guard, a sentinel/zero sell token flows
// verbatim into the quote and then into the approval path (submit.ts), where the Safe is asked
// to co-sign an approve() to a non-token plus a presign for an order that can never settle.
// Reject it up front with a clear, actionable error instead. The SDK keeps this constant
// module-private (ethflow.ts), so it is inlined here.
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
