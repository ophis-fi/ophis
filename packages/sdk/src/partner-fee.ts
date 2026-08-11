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
 *   - apps/backend/crates/app-data/src/app_data.rs
 *     (`OPHIS_NON_STABLE_FLOOR_BPS = 1` / `OPHIS_STABLE_VOLUME_FEE_BPS = 1`:
 *     the MINIMUM Volume bps the OP self-hosted backend accepts for a fee to the
 *     Ophis recipient, enforced at order ingress and re-clamped in the autopilot.
 *     every served chain requires the canonical 1 bp Ophis base.)
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
 * Partner volume fee: the @ophis/sdk default is a flat 1 bp (0.01%) of trade
 * volume on every served chain. Ophis-operated backends add capped
 * price-improvement capture; hosted appData includes the equivalent CIP-75
 * PriceImprovement entry. A Volume fee is
 * bounded above only by the autopilot's operator-set global `max_partner_fee`.
 *
 * Cross-workspace invariant (scripts/check-floor-invariant.sh): backend floor,
 * SDK default, frontend default, and integration defaults are all 1 bp.
 */
export const OPHIS_VOLUME_FEE_BPS = 1;

/** Ophis's share of reference-quote improvement on volatile pairs (80%). */
export const OPHIS_PRICE_IMPROVEMENT_BPS = 8_000;
/** Hard volatile-pair ceiling for the improvement component (0.99% of volume). */
export const OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS = 99;
/** Ophis's share of reference-quote improvement on stable pairs (50%). */
export const OPHIS_STABLE_PRICE_IMPROVEMENT_BPS = 5_000;
/** Hard stable-pair ceiling for the improvement component (0.20% of volume). */
export const OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS = 20;

/** Maximum flat fee a registered integrator may stack beside Ophis's entries. */
export const OPHIS_MAX_PARTNER_REQUEST_BPS = 90;
/**
 * Settlement-wide ceiling: Ophis's worst case (1 bp base + 99 bps captured
 * improvement) plus the registered integrator ceiling (90 bps).
 */
export const OPHIS_AGGREGATE_PARTNER_FEE_CAP_BPS = 190;

/**
 * Reduced rate for stablecoin-to-stablecoin swaps: a flat 1 bp (0.01%). The
 * Ophis frontend applies this automatically for same-chain stable pairs. This
 * SDK is chain-only (buildOphisAppDataPartnerFee takes no token context), so an
 * integrator that wants parity should pass volumeBps:OPHIS_STABLE_VOLUME_FEE_BPS
 * for stable-stable orders. Use ophisVolumeBpsForPair() to pick the right rate.
 */
export const OPHIS_STABLE_VOLUME_FEE_BPS = 1;

/** Base fee on Ophis-operated chains; price-improvement capture is enforced by
 * the sovereign backend and therefore must not be duplicated in appData. */
export const OPHIS_SOVEREIGN_VOLUME_FEE_BPS = 1;

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
  10, 130, 4663,
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
const SOVEREIGN_CHAIN_ID_SET: ReadonlySet<number> = new Set<number>([10, 130, 4663]);

/** Chain-aware volume fee for high-level order builders: 1 bp on every served chain. */
export const ophisVolumeBpsForChainAndPair = (chainId: number, isStablePair: boolean): number => {
  assertValidChainId(chainId);
  return SOVEREIGN_CHAIN_ID_SET.has(chainId)
    ? OPHIS_SOVEREIGN_VOLUME_FEE_BPS
    : ophisVolumeBpsForPair(isStablePair);
};

/**
 * Frozen, immutable list of the fee chain ids. Membership: `.includes(id)` or
 * spread it. The SDK's own fee decisions read the private Set above, never this
 * export — so freezing it can't be defeated to flip fee behavior.
 */
export const OPHIS_FEE_CHAIN_IDS: readonly number[] = Object.freeze([...FEE_CHAIN_IDS]);

export interface OphisVolumePartnerFee {
  /** Flat fee as a fraction of trade volume, in bps (1 = 0.01%). */
  readonly volumeBps: number;
  readonly recipient: `0x${string}`;
}

export interface OphisPriceImprovementPartnerFee {
  /** Share of reference-quote improvement, in bps of the improvement. */
  readonly priceImprovementBps: number;
  /** Hard ceiling, in bps of traded volume. */
  readonly maxVolumeBps: number;
  readonly recipient: `0x${string}`;
}

export type OphisPartnerFee = OphisVolumePartnerFee | OphisPriceImprovementPartnerFee;
export type OphisPartnerFeeConfig = OphisPartnerFee | readonly OphisPartnerFee[];

/**
 * Returns Ophis's CIP-75 partner-fee config for a given chain, or `undefined`
 * for chains Ophis does not serve (not in `OPHIS_FEE_CHAIN_IDS`).
 */
export const ophisDefaultPartnerFee = (
  chainId: number,
  isStablePair = false,
): OphisPartnerFeeConfig | undefined => {
  assertValidChainId(chainId);
  if (!FEE_CHAIN_ID_SET.has(chainId)) return undefined;
  const base: OphisVolumePartnerFee = {
    volumeBps: ophisVolumeBpsForChainAndPair(chainId, false),
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  };
  // Ophis-operated orderbooks apply the pair-aware improvement component as a
  // backend protocol policy. Hosted orderbooks need the equivalent CIP-75
  // entry in appData so the economics are identical without double charging.
  if (SOVEREIGN_CHAIN_ID_SET.has(chainId)) return base;
  return [
    base,
    {
      priceImprovementBps: isStablePair
        ? OPHIS_STABLE_PRICE_IMPROVEMENT_BPS
        : OPHIS_PRICE_IMPROVEMENT_BPS,
      maxVolumeBps: isStablePair
        ? OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS
        : OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
      recipient: OPHIS_PARTNER_FEE_RECIPIENT,
    },
  ];
};

/**
 * Builds the exact value for a CoW order's `appData.metadata.partnerFee`, or
 * `undefined` on chains where Ophis charges no fee. Use this instead of
 * hand-assembling it. Operated chains return the base Volume object because
 * their backend supplies improvement capture. Hosted chains return an array
 * containing the base plus the pair-aware capped PriceImprovement entry.
 *
 * @example
 *   const partnerFee = buildOphisAppDataPartnerFee(10);
 *   const appData = { metadata: { partnerFee, hooks: { pre: [], post: [] } } };
 */
export const buildOphisAppDataPartnerFee = (
  chainId: number,
  isStablePair = false,
): OphisPartnerFeeConfig | undefined => ophisDefaultPartnerFee(chainId, isStablePair);
