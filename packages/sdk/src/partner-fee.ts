/**
 * Ophis's partner-fee configuration injected into every order routed through
 * Ophis.fi. Surfaced via cow-sdk's appData `metadata.partnerFee` using the
 * CIP-75 VOLUME policy (a flat fee on trade volume), paid out by CoW DAO weekly
 * in WETH. See:
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
 * Flat volume fee: Ophis takes a flat 10 bps (0.10%) of trade volume, at or
 * below comparable aggregators (Matcha 10 bps, Velora 15 bps). Charged via the
 * CIP-75 VOLUME policy. The backend caps the volume policy at
 * `MAX_PARTNER_VOLUME_BPS` (50 bps), so 10 sits well under the ceiling.
 *
 * Must match the frontend flag value `REACT_APP_OPHIS_VOLUME_FEE_BPS` when the
 * flat fee is live; republish this SDK in lockstep with any change.
 */
export const OPHIS_VOLUME_FEE_BPS = 10;

/**
 * Reduced rate for stablecoin-to-stablecoin swaps: a flat 1 bp (0.01%). The
 * Ophis frontend applies this automatically for same-chain stable pairs. This
 * SDK is chain-only (buildOphisAppDataPartnerFee takes no token context), so an
 * integrator that wants parity should pass volumeBps:OPHIS_STABLE_VOLUME_FEE_BPS
 * for stable-stable orders. Use ophisVolumeBpsForPair() to pick the right rate.
 */
export const OPHIS_STABLE_VOLUME_FEE_BPS = 1;

/** Volume bps for a pair: 1 bp if both tokens are stablecoins, else the standard rate. */
export const ophisVolumeBpsForPair = (isStablePair: boolean): number =>
  isStablePair ? OPHIS_STABLE_VOLUME_FEE_BPS : OPHIS_VOLUME_FEE_BPS;

/**
 * Chains where Ophis charges the CIP-75 partner fee — every chain its frontend
 * serves (restored all-chain model, 2026-05-27). Ophis-operated chains settle
 * on our own stack (100%, no CoW cut); CoW-hosted chains settle via api.cow.fi
 * + CoW's solver network (CoW disburses 75% weekly).
 *
 * Mirrors the frontend gate `shouldEmitOphisPartnerFee`, whose served set is
 * the keys of `DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK` = cow-sdk's
 * `SupportedChainId` enum (`@cowprotocol/sdk-config`) plus the Ophis-operated
 * chains. This SDK has no cow-sdk dependency, so the set is hand-maintained
 * here — update it when CoW adds a supported chain (the frontend picks new
 * chains up automatically via the enum; this list does not).
 */
const FEE_CHAIN_IDS = [
  // Ophis-operated (own stack — 100%; NOT cow-sdk SupportedChainId members)
  10, 4326, 999,
  // CoW-hosted = cow-sdk SupportedChainId (settle via api.cow.fi, 75% weekly).
  // Sepolia (11155111) is the testnet member — kept so the fee path is testable.
  1, 56, 100, 137, 8453, 9745, 42161, 43114, 57073, 59144, 11155111,
] as const;

/**
 * Private O(1) membership index used by the fee-decision functions. Kept
 * separate from the exported constant so a consumer (or prototype pollution
 * elsewhere) cannot change which chains charge a fee by mutating a public value.
 */
const FEE_CHAIN_ID_SET: ReadonlySet<number> = new Set<number>(FEE_CHAIN_IDS);

/**
 * Frozen, immutable list of the fee chain ids. Membership: `.includes(id)` or
 * spread it. The SDK's own fee decisions read the private Set above, never this
 * export — so freezing it can't be defeated to flip fee behavior.
 */
export const OPHIS_FEE_CHAIN_IDS: readonly number[] = Object.freeze([...FEE_CHAIN_IDS]);

export interface OphisPartnerFee {
  /** Flat fee as a fraction of trade volume, in bps (10 = 0.10%). */
  readonly volumeBps: number;
  readonly recipient: `0x${string}`;
}

/**
 * Returns Ophis's CIP-75 partner-fee config for a given chain, or `undefined`
 * for chains Ophis does not serve (not in `OPHIS_FEE_CHAIN_IDS`).
 */
export const ophisDefaultPartnerFee = (chainId: number): OphisPartnerFee | undefined => {
  assertValidChainId(chainId);
  if (!FEE_CHAIN_ID_SET.has(chainId)) return undefined;
  return {
    volumeBps: OPHIS_VOLUME_FEE_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  };
};

/**
 * Builds the exact value for a CoW order's `appData.metadata.partnerFee`, or
 * `undefined` on chains where Ophis charges no fee. Use this instead of
 * hand-assembling the object: it guarantees the CIP-75 VOLUME shape
 * `{ volumeBps, recipient }` (a flat fee on trade volume), NOT the
 * price-improvement `{ priceImprovementBps, maxVolumeBps, recipient }` shape.
 * Mixing the two shapes is a silent magnitude error.
 *
 * @example
 *   const partnerFee = buildOphisAppDataPartnerFee(10);
 *   const appData = { metadata: { partnerFee, hooks: { pre: [], post: [] } } };
 */
export const buildOphisAppDataPartnerFee = (chainId: number): OphisPartnerFee | undefined =>
  ophisDefaultPartnerFee(chainId);
