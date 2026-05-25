/**
 * Ophis's partner-fee configuration injected into every order routed through
 * Ophis.fi. Surfaced via cow-sdk's appData `metadata.partnerFee` using the
 * CIP-75 PRICE-IMPROVEMENT policy, paid out by CoW DAO weekly in WETH. See:
 *   - https://docs.cow.fi/governance/fees/partner-fee
 *   - docs/development/specs/2026-05-03-ophis-design-amendment.md
 *
 * SOURCE OF TRUTH for the live fee. Keep in sync with:
 *   - apps/frontend/apps/cowswap-frontend/src/ophis/partnerFeeDefault.ts
 *     (`OPHIS_DEFAULT_APP_DATA_PARTNER_FEE`; separate pnpm workspace, mirrored)
 *   - apps/backend/crates/app-data/src/app_data.rs caps
 *     (`MAX_PARTNER_FEE_BPS = 2500`, `MAX_PARTNER_VOLUME_BPS = 50`)
 *   - apps/frontend/.../appData/updater/shouldEmitOphisPartnerFee.ts (chain gate)
 */

/**
 * Recipient — Safe multisig deployed on Gnosis Chain on 2026-05-03 at version
 * 1.4.1. CREATE2-deterministic: the same address resolves on every chain
 * where Safe's `SafeProxyFactory` is deployed. Funds sent to this address on a
 * chain where the proxy isn't yet deployed are still receivable; deploy the
 * proxy on that chain when payouts there warrant the gas to spend them.
 *
 * Initial setup: threshold 1-of-1, owner = `0x0494F503912C101Bfd76b88e4F5D8A33de284d1A`.
 * Phase 2.6 / pre-revenue task: upgrade to ≥ 2-of-N before significant accrual.
 *
 * Previous recipient (Phase 1.5 single-sig EOA, retired 2026-05-03):
 *   `0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E` (Keychain `ophis-partner-fee-recipient`).
 */
export const OPHIS_PARTNER_FEE_RECIPIENT =
  '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as `0x${string}`;

/**
 * Price-improvement fee: Ophis takes 25% (2500 bps) of any execution that
 * beats the quote shown to the user. Ordinary trades that don't beat the quote
 * pay nothing. The backend rejects values above this at app-data validation
 * (`MAX_PARTNER_FEE_BPS`).
 */
export const OPHIS_PRICE_IMPROVEMENT_BPS = 2500;

/**
 * Hard ceiling on the fee as a fraction of trade volume (CIP-75 `maxVolumeBps`):
 * 50 bps (0.5%). Protects large trades; backend caps this at `MAX_PARTNER_VOLUME_BPS`.
 */
export const OPHIS_MAX_VOLUME_BPS = 50;

/**
 * Chains where Ophis operates its own stack and therefore charges the partner
 * fee. Mirrors the frontend gate `shouldEmitOphisPartnerFee` — exactly the
 * chains whose per-network fee recipient is the Ophis Safe. On all other
 * (CoW-hosted) chains Ophis does not operate and collects no partner fee.
 *   - 10   Optimism (live)
 *   - 4326 MegaETH  (paused)
 *   - 999  HyperEVM (paused)
 */
export const OPHIS_FEE_CHAIN_IDS: ReadonlySet<number> = new Set<number>([10, 4326, 999]);

export interface OphisPartnerFee {
  /** Share of price improvement over the user's quote, in bps (2500 = 25%). */
  readonly priceImprovementBps: number;
  /** Hard cap on the fee as a fraction of trade volume, in bps (50 = 0.5%). */
  readonly maxVolumeBps: number;
  readonly recipient: `0x${string}`;
}

/**
 * Returns Ophis's CIP-75 partner-fee config for a given chain, or `undefined`
 * for chains where Ophis does not operate a stack (and so charges no fee).
 */
export const ophisDefaultPartnerFee = (chainId: number): OphisPartnerFee | undefined => {
  if (!OPHIS_FEE_CHAIN_IDS.has(chainId)) return undefined;
  return {
    priceImprovementBps: OPHIS_PRICE_IMPROVEMENT_BPS,
    maxVolumeBps: OPHIS_MAX_VOLUME_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  };
};
