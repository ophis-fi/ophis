/**
 * Greg's partner-fee configuration injected into every order routed through
 * Greg.app. Surfaced via cow-sdk's appData metadata.partnerFee, paid out by
 * CoW DAO weekly in WETH. See:
 *   - https://docs.cow.fi/governance/fees/partner-fee
 *   - docs/superpowers/specs/2026-05-03-greg-design-amendment.md
 */

/** Recipient EOA — generated 2026-05-03, key in macOS Keychain entry `greg-partner-fee-recipient`. */
export const GREG_PARTNER_FEE_RECIPIENT =
  '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E' as `0x${string}`;

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
