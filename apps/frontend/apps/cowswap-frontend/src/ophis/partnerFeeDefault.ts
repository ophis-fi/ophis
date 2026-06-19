/**
 * Ophis partner-fee defaults.
 *
 * Source of truth: `packages/sdk/src/partner-fee.ts`. Keep these values in
 * sync with the outer monorepo (the cowswap fork lives in its own pnpm
 * workspace and cannot import from `@ophis/sdk`). Whenever `@ophis/sdk`
 * changes, mirror the change here in the same PR.
 *
 * Strategy: per CIP-75 (passed Nov 2025), CoW Protocol partners can choose
 * between three monetisation models — `volumeBps` (flat), `surplusBps`
 * (% of on-chain surplus), or `priceImprovementBps` (% of execution that
 * beats the quote). Ophis runs the FLAT volumeBps model in production
 * (REACT_APP_OPHIS_VOLUME_FEE_BPS=10 is set at build time, see
 * cloudflare-deploy.yml); the price-improvement object below is only the
 * flag-off fallback.
 *
 * - https://docs.cow.fi/governance/fees/partner-fee
 * - https://forum.cow.fi/t/cip-75-partner-incentive-alignment/3253
 */

import type { PartnerFee } from '@cowprotocol/widget-lib'

/**
 * Recipient — Safe multisig on Gnosis (CREATE2-deterministic, same address
 * resolves on all 10 CoW chains). Threshold 2-of-3 (verified on-chain on
 * Optimism: getThreshold=2, three owners).
 */
export const OPHIS_PARTNER_FEE_RECIPIENT = '0x858f0F5eE954846D47155F5203c04aF1819eCeF8' as const

/**
 * FLAG-GATED FEE MODEL. Default OFF = the legacy price-improvement model
 * (the fallback only; PRODUCTION RUNS WITH THE FLAG ON). Set
 * `REACT_APP_OPHIS_VOLUME_FEE_BPS` to an integer in
 * [BACKEND_NON_STABLE_FLOOR_BPS, 50] to switch the LIVE fee to a FLAT volume
 * fee of that many bps (prod sets 10 = 0.10% via a GH repo secret consumed in
 * cloudflare-deploy.yml).
 *
 * Lower bound: the OP self-hosted backend enforces a token-pair-aware MINIMUM
 * partner fee to the Ophis recipient (app_data.rs `partner_fee_floor_bps`,
 * checked at order ingress and re-clamped in the autopilot): 4 bps for any
 * non-stable pair, 1 bp for same-chain stable pairs. A base rate below the
 * non-stable floor would make the backend reject non-stable orders at ingress
 * (PartnerFeeBelowFloor), so a sub-floor value disables the flag (fee model
 * stays off) instead of building rejectable orders. Stable pairs are charged
 * 1 bp separately via OPHIS_STABLE_VOLUME_BPS.
 *
 * Upper bound 50: a Volume fee is bounded above only by the autopilot global
 * `max_partner_fee` (100 bps); 50 keeps us well under it and at/under the
 * competitor rate (Matcha 10, Velora 15).
 */
// The Ophis front-end's RETAIL non-stable Volume rate (10 bps). swap.ophis.fi
// charges this, and it is the LOWER BOUND for the env flag below: a build can
// only configure a retail rate AT OR ABOVE it. A partner-tier value (e.g. 5)
// must NOT enable the flag, or OP retail orders would be undercharged at the
// partner rate. Decoupled from the backend floor (BACKEND_NON_STABLE_FLOOR_BPS).
const OPHIS_FRONTEND_OP_VOLUME_BPS = 10
// The OP self-hosted backend's MINIMUM non-stable Volume bps (mirrors
// app_data.rs OPHIS_NON_STABLE_FLOOR_BPS = 4). Used ONLY as the cross-workspace
// floor-invariant mirror (scripts/check-floor-invariant.sh), NOT the env bound:
// partner integrations charge 5 bps (via @ophis/sdk) above this floor while
// swap.ophis.fi keeps the 10 bps retail rate.
const BACKEND_NON_STABLE_FLOOR_BPS = 4
function readVolumeFeeBps(): number {
  const raw = Number(process.env.REACT_APP_OPHIS_VOLUME_FEE_BPS)
  // Lower bound is the RETAIL rate, NOT the backend floor: a partner-tier env
  // value (e.g. 5) must DISABLE the flag (the OP path then charges the 10 bps
  // retail via ophisVolumeOnlyFloorFee) rather than make the front-end charge 5.
  return Number.isInteger(raw) && raw >= OPHIS_FRONTEND_OP_VOLUME_BPS && raw <= 50 ? raw : 0
}
/** Flat-volume-fee bps when the flag is enabled (0 = flag off). */
export const OPHIS_VOLUME_BPS = readVolumeFeeBps()
/** True when the flat-volume-fee flag is set; flips the model below + in the appData atom. */
export const OPHIS_FLAT_VOLUME_FEE_ENABLED = OPHIS_VOLUME_BPS > 0

/**
 * Reduced rate for stablecoin-to-stablecoin swaps: a flat 1 bp (0.01%) instead
 * of the standard OPHIS_VOLUME_BPS. Applied (in volumeFeeAtom) only when the
 * flat fee is enabled AND both sides of a SAME-CHAIN trade are stablecoins.
 * Capped at the base rate so it can never exceed the standard fee.
 */
export const OPHIS_STABLE_VOLUME_BPS = Math.min(1, OPHIS_VOLUME_BPS || 1)

/**
 * The volumeFee-pipeline fee. It drives the quote DISPLAY and, via the
 * `ophisAppDataPartnerFee ?? volumeFee` precedence in AppDataUpdater, also the
 * on-chain appData fee WHEN the direct price-improvement object below is
 * suppressed (which `injectedWidgetAppDataPartnerFeeAtom` does iff the flag is
 * on). Default 0 keeps the volumeFee pipeline silent so the price-improvement
 * `OPHIS_DEFAULT_APP_DATA_PARTNER_FEE` carries the on-chain fee. When the flag
 * is on, display and on-chain both read this single value, so they stay in
 * lockstep with no hidden or double charge.
 */
export const OPHIS_DEFAULT_PARTNER_FEE: PartnerFee = {
  bps: OPHIS_FLAT_VOLUME_FEE_ENABLED ? OPHIS_VOLUME_BPS : 0,
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
}

/**
 * Ophis on-chain partner-fee config — written into appData.metadata.partnerFee.
 *
 * `priceImprovementBps: 2500` (25%) takes a quarter of any execution that
 * beats the quote shown to the user. `maxVolumeBps: 50` (0.5%) is the
 * required hard ceiling — protects whales and matches CIP-75's "1% of
 * nominal" upper bound while sitting comfortably below it.
 *
 * CoW DAO retains 25% of this as a service fee (negotiable), leaving
 * Ophis with ~18.75% of price improvement, capped at 0.5% of trade
 * volume. Settles weekly to the recipient Safe.
 */
export const OPHIS_DEFAULT_APP_DATA_PARTNER_FEE = {
  priceImprovementBps: 2500,
  maxVolumeBps: 50,
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
} as const

/**
 * Chains whose self-hosted Ophis backend mandates the CIP-75 VOLUME policy and
 * REJECTS Surplus/PriceImprovement partner fees at order ingress (app_data.rs
 * `validate_partner_fees`). The price-improvement fallback above
 * (OPHIS_DEFAULT_APP_DATA_PARTNER_FEE) must NEVER be emitted on these chains or
 * ingress returns 400. Optimism (10) is the only self-hosted chain today;
 * CoW-hosted chains validate via api.cow.fi and still accept the PI shape.
 */
const VOLUME_ONLY_CHAIN_IDS: ReadonlySet<number> = new Set<number>([10])

/** The OP non-stable RETAIL fee the front-end charges and writes on-chain (OPHIS_FRONTEND_OP_VOLUME_BPS = 10 bps, hoisted above). */
export const OPHIS_NON_STABLE_VOLUME_BPS = OPHIS_FRONTEND_OP_VOLUME_BPS

/** True on a self-hosted, Volume-only, fee-floor-enforcing chain (Optimism today). */
export function isVolumeOnlyChain(chainId: number | undefined): boolean {
  return chainId !== undefined && VOLUME_ONLY_CHAIN_IDS.has(chainId)
}

/**
 * The Ophis floor VOLUME fee for a self-hosted Volume-only chain (Optimism), or
 * `undefined` off those chains. On OP the backend enforces a fee FLOOR and would
 * reject a sub-floor fee or let an ABSENT one ride free, so the Ophis fee must be
 * present at >= the floor whether or not the flat-volume flag is on. This is the
 * SINGLE source used for BOTH the displayed fee row and the on-chain appData fee
 * (see volumeFeeAtom), so the two never diverge. `reducedRate` true (a same-chain
 * stablecoin pair or a boosted token) floors at the reduced 1 bp; otherwise the
 * 10 bps non-stable floor. Recipient is the canonical Ophis Safe.
 */
export function ophisVolumeOnlyFloorFee(
  chainId: number | undefined,
  reducedRate: boolean,
): { volumeBps: number; recipient: typeof OPHIS_PARTNER_FEE_RECIPIENT } | undefined {
  if (!isVolumeOnlyChain(chainId)) return undefined
  return {
    volumeBps: reducedRate ? OPHIS_STABLE_VOLUME_BPS : OPHIS_NON_STABLE_VOLUME_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  }
}

/**
 * Gates the on-chain Ophis price-improvement partner-fee value by chain. On
 * VOLUME-only chains (Optimism) the self-hosted backend REJECTS the PI shape at
 * ingress, so suppress it (return `undefined`) and let the volumeFee pipeline
 * carry the floor Volume fee instead (ophisVolumeOnlyFloorFee, surfaced via
 * volumeFeeAtom) so the displayed fee and the on-chain appData fee stay in
 * lockstep and the order is never free or rejected on OP. Pass `raw` through
 * unchanged on every other (CoW-hosted) chain, where the PI shape is valid.
 */
export function ophisAppDataPartnerFeeForChain<T>(raw: T | undefined, chainId: number | undefined): T | undefined {
  if (isVolumeOnlyChain(chainId)) return undefined
  return raw
}
