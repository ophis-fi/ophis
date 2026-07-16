/**
 * Request-binding + fee/slippage hardening for the Ophis Safe presign builder.
 *
 * These are the guards the EOA path (packages/agent-swap/src/swap.ts) enforces
 * but the current apps/safe-app path omits. They are PURE (no I/O) so the
 * headless builder and the safe-app refactor share one hardened codepath, and
 * every branch is unit-tested. See
 * docs/development/specs/2026-07-15-vault-curator-rebalance-venue-design.md.
 */

export const MAX_SLIPPAGE_BPS = 5000;
export const DEFAULT_SLIPPAGE_BPS = 50;

/** Native-ETH sentinel used by aggregators. The vault path is ERC-20 only. */
const NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const norm = (addr: string): string => addr.toLowerCase();

/**
 * ERC-20 only: reject a native sentinel / zero / malformed token before any
 * network round-trip or approve(). Native-ETH rebalances are out of scope for
 * Phase A (they need the eth-flow / wrap path, deliberately excluded).
 */
export function assertErc20(token: string, label: string): void {
  if (typeof token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    throw new Error(`${label} ${String(token)} is not a valid ERC-20 address`);
  }
  const t = norm(token);
  if (t === norm(NATIVE_SENTINEL) || t === ZERO_ADDRESS) {
    throw new Error(`${label} ${token} is native ETH / zero; the vault path is ERC-20 only`);
  }
}

/** Invariant 7b: slippage must be an integer in [0, MAX_SLIPPAGE_BPS]. */
export function assertSlippageBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) {
    throw new Error(`slippageBps ${bps} out of range [0, ${MAX_SLIPPAGE_BPS}]`);
  }
}

/** Lower the buy floor by `bps`, so the quoted price is a floor, not an exact requirement. */
export function applySlippage(amount: bigint, bps: number): bigint {
  assertSlippageBps(bps);
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

/**
 * Invariant 1: the signed order's feeAmount must be exactly "0". Ophis/CoW
 * orders take the fee from surplus + the appData partner fee, never a signed
 * feeAmount (a non-zero one is unslipped extra spend and the orderbook rejects
 * it). NEVER sign the quote's feeAmount.
 */
export function assertSignedFeeZero(feeAmount: string): void {
  if (feeAmount !== '0') {
    throw new Error(`signed feeAmount must be "0" (fee rides in appData partnerFee); got ${feeAmount}`);
  }
}

/**
 * Invariant 6: bind the signed order back to the REQUEST. The orderbook host is
 * trusted for pricing, but the fields the Safe presigns must not drift from what
 * the caller asked for: a compromised quote must not substitute tokens or change
 * the amount pulled. Tokens must match exactly, and the gross (quote sellAmount +
 * feeAmount) must EQUAL the requested amount (an honest CoW sell quote splits
 * sellAmountBeforeFee exactly, so any drift up = over-pull, down = under-sell).
 */
export function assertRequestBound(args: {
  requestedSellToken: string;
  requestedBuyToken: string;
  requestedGross: bigint;
  quoteSellToken: string;
  quoteBuyToken: string;
  quoteGross: bigint;
}): void {
  if (norm(args.quoteSellToken) !== norm(args.requestedSellToken)) {
    throw new Error(`quote sellToken ${args.quoteSellToken} != requested ${args.requestedSellToken}; refusing to sign`);
  }
  if (norm(args.quoteBuyToken) !== norm(args.requestedBuyToken)) {
    throw new Error(`quote buyToken ${args.quoteBuyToken} != requested ${args.requestedBuyToken}; refusing to sign`);
  }
  if (args.quoteGross !== args.requestedGross) {
    throw new Error(
      `quote gross (sellAmount+feeAmount = ${args.quoteGross}) != requested ${args.requestedGross}; refusing to sign`,
    );
  }
}

/**
 * Invariant 7: reject a zero-proceeds order, and (if the caller supplies one)
 * any order whose signed buy floor is below the caller's own minimum-out.
 *
 * The zero check alone stops a max-sandwich (buyAmount rounding to 0), but a
 * hostile quote host could still return a tiny-but-nonzero buyAmount and drain
 * value at a terrible price. We cannot assert a GOOD price without an oracle,
 * but the CURATOR has its own NAV/valuation, so it can pass `minBuyAmount` (in
 * atomic units) as a hard floor: the signed order's buy limit must meet it or we
 * refuse to sign. This pushes the price-trust to the curator, not the host.
 */
export function assertBuyFloor(buyAmount: bigint, minBuyAmount?: bigint): void {
  if (buyAmount <= 0n) {
    throw new Error(`buy floor is 0; refusing to sign a zero-proceeds order`);
  }
  if (minBuyAmount !== undefined && buyAmount < minBuyAmount) {
    throw new Error(
      `signed buy floor ${buyAmount} is below the caller's minBuyAmount ${minBuyAmount}; ` +
        `refusing to sign (quote is below your minimum out)`,
    );
  }
}
