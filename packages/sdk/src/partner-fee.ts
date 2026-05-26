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

import { assertValidChainId } from './guards.js';

/**
 * Recipient — the Ophis partner-fee Safe multisig. CREATE2-deterministic: the
 * same address resolves on every chain where Safe's `SafeProxyFactory` is
 * deployed. Funds sent on a chain where the proxy isn't deployed yet are still
 * receivable; deploy the proxy there when payouts warrant the gas.
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
  assertValidChainId(chainId);
  if (!OPHIS_FEE_CHAIN_IDS.has(chainId)) return undefined;
  return {
    priceImprovementBps: OPHIS_PRICE_IMPROVEMENT_BPS,
    maxVolumeBps: OPHIS_MAX_VOLUME_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  };
};

/**
 * Builds the exact value for a CoW order's `appData.metadata.partnerFee`, or
 * `undefined` on chains where Ophis charges no fee. Use this instead of
 * hand-assembling the object — it guarantees the CIP-75 price-improvement shape
 * `{ priceImprovementBps, maxVolumeBps, recipient }`, NOT the flat
 * `{ bps, recipient }` widget shape (mixing them is a silent 100x fee error).
 *
 * @example
 *   const partnerFee = buildOphisAppDataPartnerFee(10);
 *   const appData = { metadata: { partnerFee, hooks: { pre: [], post: [] } } };
 */
export const buildOphisAppDataPartnerFee = (chainId: number): OphisPartnerFee | undefined =>
  ophisDefaultPartnerFee(chainId);
