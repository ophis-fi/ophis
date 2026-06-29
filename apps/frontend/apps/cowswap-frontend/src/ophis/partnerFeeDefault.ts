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
 * (the fallback only; PRODUCTION RUNS WITH THE FLAG ON). The flag enables ONLY
 * when `REACT_APP_OPHIS_VOLUME_FEE_BPS` equals EXACTLY the retail rate
 * OPHIS_FRONTEND_OP_VOLUME_BPS (10 = 0.10%, set via a GH repo secret consumed in
 * cloudflare-deploy.yml). Any other value keeps the flag OFF.
 *
 * Why EXACTLY the retail rate (not a range):
 *  - Sub-retail (e.g. the 5 bps partner rate): the front-end must NOT charge a
 *    partner-tier fee to its own retail users. A sub-retail value disables the
 *    flag; the OP path then charges the 10 bps retail via ophisVolumeOnlyFloorFee
 *    and CoW-hosted chains use the price-improvement object. The deploy guard
 *    rejects such a secret before build so production can never silently ship the
 *    legacy fallback at the wrong rate.
 *  - Super-retail (>10): if the front-end could emit a retail fee above 10, the
 *    autopilot's operator cap (asserted `>= retail`) could silently clamp it down
 *    at settlement. Pinning to exactly the retail rate keeps that assert sufficient.
 *  - Stable pairs are charged 1 bp separately via OPHIS_STABLE_VOLUME_BPS; the OP
 *    backend floor (4 bps non-stable, 1 bp stable) is enforced server-side and is
 *    BELOW the retail rate, so it never gates the retail front-end.
 */
// The Ophis front-end's RETAIL non-stable Volume rate (10 bps). swap.ophis.fi
// charges this, and it is the LOWER BOUND for the env flag below: a build can
// only configure a retail rate AT OR ABOVE it. A partner-tier value (e.g. 5)
// must NOT enable the flag, or OP retail orders would be undercharged at the
// partner rate. Decoupled from the backend floor (BACKEND_NON_STABLE_FLOOR_BPS).
const OPHIS_FRONTEND_OP_VOLUME_BPS = 10
// The OP self-hosted backend's MINIMUM non-stable Volume bps (mirrors
// app_data.rs OPHIS_NON_STABLE_FLOOR_BPS = 4). The cross-workspace floor-invariant
// gate (scripts/check-floor-invariant.sh) greps this declaration to assert
// floor(4) <= partner(5) <= retail(10). It is NOT the env bound: partner
// integrations charge 5 bps (via @ophis/sdk) above this floor while swap.ophis.fi
// keeps the 10 bps retail rate. Exported (not a bare local) so it documents the
// mirrored backend floor for any consumer and is not flagged as an unused local.
export const BACKEND_NON_STABLE_FLOOR_BPS = 4
function readVolumeFeeBps(): number {
  // EXACT-STRING match against the retail rate, identical to the CI deploy guard's
  // byte compare (`[[ "$BPS" != "10" ]]` in cloudflare-deploy.yml). Using the raw
  // string (not Number()) keeps the two gates equivalent: a malformed-but-coercible
  // secret like '010' / '10.0' / '1e1' must NOT enable the flag here when CI would
  // reject it, so neither gate is solely load-bearing. The flag enables ONLY for
  // exactly the retail rate; a partner-tier value (5), a super-retail value, or any
  // garbage DISABLES it (the OP path then charges the 10 bps retail via
  // ophisVolumeOnlyFloorFee; CoW-hosted chains fall back to the price-improvement
  // object). Pinning to exactly the retail rate is also what makes the autopilot
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
 * ingress returns 400. Optimism (10) and Unichain (130) are the self-hosted
 * chains today; CoW-hosted chains validate via api.cow.fi and still accept the
 * PI shape.
 */
const VOLUME_ONLY_CHAIN_IDS: ReadonlySet<number> = new Set<number>([10, 130])

/** The OP non-stable RETAIL fee the front-end charges and writes on-chain (OPHIS_FRONTEND_OP_VOLUME_BPS = 10 bps, hoisted above). */
export const OPHIS_NON_STABLE_VOLUME_BPS = OPHIS_FRONTEND_OP_VOLUME_BPS

/** True on a self-hosted, Volume-only, fee-floor-enforcing chain (Optimism, Unichain today). */
export function isVolumeOnlyChain(chainId: number | undefined): boolean {
  return chainId !== undefined && VOLUME_ONLY_CHAIN_IDS.has(chainId)
}

/**
 * The Ophis floor VOLUME fee for a self-hosted Volume-only chain (Optimism,
 * Unichain), or `undefined` off those chains. On those chains the backend
 * enforces a fee FLOOR and would
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
 * VOLUME-only chains (Optimism, Unichain) the self-hosted backend REJECTS the PI shape at
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
