/**
 * Greg's partner-fee configuration injected into every order routed through
 * Greg.app. Surfaced via cow-sdk's appData metadata.partnerFee, paid out by
 * CoW DAO weekly in WETH. See:
 *   - https://docs.cow.fi/governance/fees/partner-fee
 *   - docs/superpowers/specs/2026-05-03-greg-design-amendment.md
 */

/**
 * Recipient — Safe multisig deployed on Gnosis Chain on 2026-05-03 at version
 * 1.4.1. CREATE2-deterministic: the same address resolves on every chain
 * where Safe's `SafeProxyFactory` is deployed (all 10 CoW-supported chains).
 * Funds sent to this address on a chain where the proxy isn't yet deployed
 * are still receivable; deploy the proxy on that chain when payouts there
 * warrant the gas to spend them.
 *
 * Initial setup: threshold 1-of-1, owner = `0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`.
 * Phase 2.6 / pre-revenue task: upgrade to ≥ 2-of-N before significant accrual.
 *
 * Previous recipient (Phase 1.5 single-sig EOA, retired 2026-05-03):
 *   `0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E` (Keychain `greg-partner-fee-recipient`).
 */
export const GREG_PARTNER_FEE_RECIPIENT =
  '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as `0x${string}`;

/** Default fee in basis points. 1 bps = 0.01%. CoW caps partner fees at 100 bps. */
export const GREG_PARTNER_FEE_BPS = 5;

/** Chains where CoW Protocol is deployed (May 2026). Source: https://docs.cow.fi/cow-protocol/reference/contracts/core */
export const COW_SUPPORTED_CHAIN_IDS = new Set<number>([
  1,        // Ethereum
  100,      // Gnosis Chain
  8453,     // Base
  42161,    // Arbitrum One
  137,      // Polygon
  43114,    // Avalanche
  56,       // BNB Chain
  59144,    // Linea
  9745,     // Plasma
  57073,    // Ink
  // Sepolia (11155111) is a testnet; CoW supports it for staging.
  11155111,
]);

export interface GregPartnerFee {
  readonly bps: number;
  readonly recipient: `0x${string}`;
}

/** Returns Greg's default partner-fee config for a given chain, or undefined for unsupported chains. */
export const gregDefaultPartnerFee = (chainId: number): GregPartnerFee | undefined => {
  if (!COW_SUPPORTED_CHAIN_IDS.has(chainId)) return undefined;
  return { bps: GREG_PARTNER_FEE_BPS, recipient: GREG_PARTNER_FEE_RECIPIENT };
};
