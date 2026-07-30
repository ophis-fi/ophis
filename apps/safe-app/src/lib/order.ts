import { assembleVaultOrder, ORDER_TTL_SECONDS, type VaultOrder } from '@ophis/safe-swap';

/**
 * The order the Safe presigns. Since the guard-parity refactor this IS the
 * hardened @ophis/safe-swap VaultOrder: feeAmount is the literal '0' (the fee
 * rides only in appData partnerFee), sellAmount is the GROSS the user asked to
 * sell, validTo is set locally, kind is the 'sell' wire literal.
 */
export type QuotedOrder = VaultOrder;

/**
 * What the user actually asked for, captured WITH the quote so the signed order
 * can be bound back to it (assertRequestBound): a hostile/compromised quote host
 * must not be able to substitute tokens or change the amount the Safe pulls.
 * sellToken is the POST-wrap-mapping token (WETH when selling native ETH).
 */
export interface RequestedTrade {
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** Atomic gross the user asked to sell (the sellAmountBeforeFee sent to the quote). */
  sellAmount: string;
}

/**
 * Build the final order from a CoW quote via the shared @ophis/safe-swap
 * assembly, which enforces the full guard set (guard parity with the headless
 * vault builder + the EOA agent path):
 *  - receiver pinned to the Safe (drain guard)
 *  - signed feeAmount '0'; sellAmount = quote sellAmount + feeAmount (gross)
 *  - request binding: tokens + gross must equal what the user asked for
 *  - buy floor > 0 (zero-proceeds rejection), slippage capped at MAX_SLIPPAGE_BPS
 *  - validTo set LOCALLY (never trusted from the quote), partiallyFillable false
 */
export function assembleOrder(
  owner: `0x${string}`,
  quote: any,
  appDataHash: string,
  requested: RequestedTrade,
  slippageBps = 50,
): QuotedOrder {
  const q = quote.quote ?? quote;

  return assembleVaultOrder({
    safe: owner,
    quoteSellToken: String(q.sellToken),
    quoteBuyToken: String(q.buyToken),
    quoteSellAmount: String(q.sellAmount),
    quoteFeeAmount: String(q.feeAmount ?? '0'),
    quoteBuyAmount: String(q.buyAmount),
    requestedSellToken: requested.sellToken,
    requestedBuyToken: requested.buyToken,
    requestedGross: BigInt(requested.sellAmount),
    appDataHash,
    slippageBps,
    ttlSeconds: ORDER_TTL_SECONDS,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
}
