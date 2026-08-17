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
 * beats the quote). Ophis combines a 1 bp Volume base with capped
 * PriceImprovement capture on hosted chains. Operated-chain backends apply the
 * same improvement policy directly, so their appData carries only the base.
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
 * FLAG-GATED BASE-FEE DISPLAY. Production enables the 1 bp Volume base only
 * when `REACT_APP_OPHIS_VOLUME_FEE_BPS` equals EXACTLY the retail rate
 * OPHIS_FRONTEND_OP_VOLUME_BPS (1 = 0.01%, set via a GH repo secret consumed in
 * cloudflare-deploy.yml). Any other value keeps the flag OFF.
 *
 * Pinning the flag to exactly 1 bp prevents stale deployment configuration from
 * silently reintroducing an obsolete fee. The backend floor is also 1 bp.
 */
// Canonical Ophis fee on every supported chain and pair.
const OPHIS_FRONTEND_OP_VOLUME_BPS = 1
// The OP self-hosted backend's MINIMUM non-stable Volume bps (mirrors
// app_data.rs OPHIS_NON_STABLE_FLOOR_BPS = 1). The cross-workspace floor-invariant
// gate (scripts/check-floor-invariant.sh) greps this declaration to assert
// floor(1) == SDK(1) == frontend(1). Exported so it documents the
// mirrored backend floor for any consumer and is not flagged as an unused local.
export const BACKEND_NON_STABLE_FLOOR_BPS = 1
export const OPHIS_SOVEREIGN_BASE_FEE_BPS = 1
export const OPHIS_PRICE_IMPROVEMENT_BPS = 8000
export const OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS = 99
export const OPHIS_STABLE_PRICE_IMPROVEMENT_BPS = 5000
export const OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS = 20
export const OPHIS_MAX_PARTNER_REQUEST_BPS = 90
export const OPHIS_AGGREGATE_PARTNER_FEE_CAP_BPS = 190
function readVolumeFeeBps(): number {
  // EXACT-STRING match against the retail rate, identical to the CI deploy guard's
  // byte compare (`[[ "$BPS" != "1" ]]` in cloudflare-deploy.yml). Using the raw
  // string (not Number()) keeps the two gates equivalent: a malformed-but-coercible
  // secret like '01' / '1.0' / '1e0' must NOT enable the flag here when CI would
  // reject it, so neither gate is solely load-bearing. The flag enables ONLY for
  // exactly the canonical rate; a higher value or any
  // garbage DISABLES it (the OP path still floors at 1 bp). Pinning to exactly
  // the retail rate is also what makes the autopilot
  // startup assert (cap >= retail) provably sufficient: the front-end can never emit
  // a retail fee ABOVE OPHIS_FRONTEND_OP_VOLUME_BPS, so the operator cap can never
  // silently clamp a legitimate retail order down.
  const raw = process.env.REACT_APP_OPHIS_VOLUME_FEE_BPS
  return raw === String(OPHIS_FRONTEND_OP_VOLUME_BPS) ? OPHIS_FRONTEND_OP_VOLUME_BPS : 0
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
 * on-chain appData base when the hosted all-chain config below is suppressed on
 * an operated chain. The hosted config contains the same base plus improvement
 * entry; AppDataUpdater gives it precedence so the base is never duplicated.
 */
export const OPHIS_DEFAULT_PARTNER_FEE: PartnerFee = {
  bps: OPHIS_FLAT_VOLUME_FEE_ENABLED ? OPHIS_VOLUME_BPS : 0,
  recipient: OPHIS_PARTNER_FEE_RECIPIENT,
}

/**
 * Ophis on-chain partner-fee config — written into appData.metadata.partnerFee.
 *
 * Volatile pairs use 80% of reference-quote improvement with a 99 bps volume
 * cap. Stable pairs use 50% with a 20 bps cap. Both include the 1 bp base.
 */
export const OPHIS_DEFAULT_APP_DATA_PARTNER_FEE = [
  { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
  {
    priceImprovementBps: OPHIS_PRICE_IMPROVEMENT_BPS,
    maxVolumeBps: OPHIS_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  },
]

export const OPHIS_STABLE_APP_DATA_PARTNER_FEE = [
  { volumeBps: 1, recipient: OPHIS_PARTNER_FEE_RECIPIENT },
  {
    priceImprovementBps: OPHIS_STABLE_PRICE_IMPROVEMENT_BPS,
    maxVolumeBps: OPHIS_STABLE_PRICE_IMPROVEMENT_MAX_VOLUME_BPS,
    recipient: OPHIS_PARTNER_FEE_RECIPIENT,
  },
]

/**
 * Chains whose self-hosted Ophis backend mandates the CIP-75 VOLUME policy and
 * REJECTS Surplus/PriceImprovement partner fees at order ingress (app_data.rs
 * `validate_partner_fees`). The price-improvement fallback above
 * (OPHIS_DEFAULT_APP_DATA_PARTNER_FEE) must NEVER be emitted on these chains or
 * ingress returns 400. Optimism (10) and Unichain (130) are the self-hosted
 * chains today; CoW-hosted chains validate via api.cow.fi and still accept the
 * PI shape.
 */
const VOLUME_ONLY_CHAIN_IDS: ReadonlySet<number> = new Set<number>([10, 130, 4663])

/** The 1 bp base the front-end writes on Ophis-operated chains. */
export const OPHIS_NON_STABLE_VOLUME_BPS = OPHIS_SOVEREIGN_BASE_FEE_BPS

/** True on an Ophis-operated, Volume-only, fee-floor-enforcing chain. */
export function isVolumeOnlyChain(chainId: number | undefined): boolean {
  return chainId !== undefined && VOLUME_ONLY_CHAIN_IDS.has(chainId)
}

/**
 * The Ophis floor VOLUME fee for an operated Volume-only chain (Optimism,
 * Unichain, or Robinhood Chain), or `undefined` off those chains. There the backend
 * enforces a fee FLOOR and would
 * reject a sub-floor fee or let an ABSENT one ride free, so the Ophis fee must be
 * present at >= the floor whether or not the flat-volume flag is on. This is the
 * SINGLE source used for BOTH the displayed fee row and the on-chain appData fee
 * (see volumeFeeAtom), so the two never diverge. `reducedRate` true (a same-chain
 * stablecoin pair or a boosted token) floors at the reduced 1 bp; otherwise the
 * 1 bp sovereign base. Recipient is the canonical Ophis Safe.
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
 * VOLUME-only chains (Optimism, Unichain) the self-hosted backend REJECTS the PI shape at
 * ingress, so suppress it (return `undefined`) and let the volumeFee pipeline
 * carry the floor Volume fee instead (ophisVolumeOnlyFloorFee, surfaced via
 * volumeFeeAtom) so the displayed fee and the on-chain appData fee stay in
 * lockstep and the order is never free or rejected on OP. Pass `raw` through
 * unchanged on every other (CoW-hosted) chain, where the PI shape is valid.
 */
export function ophisAppDataPartnerFeeForChain<T>(
  raw: T | undefined,
  chainId: number | undefined,
  isStablePair = false,
): T | undefined {
  if (isVolumeOnlyChain(chainId)) return undefined
  if (isStablePair && raw === OPHIS_DEFAULT_APP_DATA_PARTNER_FEE) {
    return OPHIS_STABLE_APP_DATA_PARTNER_FEE as T
  }
  return raw
}
