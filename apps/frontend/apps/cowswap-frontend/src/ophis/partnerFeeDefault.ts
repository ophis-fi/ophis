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
 * (the fallback only — PRODUCTION RUNS WITH THE FLAG ON). Set
 * `REACT_APP_OPHIS_VOLUME_FEE_BPS` to an integer in [1, 50] to switch the
 * LIVE fee to a FLAT volume fee of that many bps (prod sets 10 = 0.10% via
 * a GH repo secret consumed in cloudflare-deploy.yml).
 *
 * Why <=50: the OP self-hosted backend's CIP-75 Volume policy bypasses the
 * per-order cap (app_data.rs) and is bounded only by the autopilot global
 * `max_partner_fee` (100 bps); 50 keeps us well under it and at/under the
 * competitor floor (Matcha 10, Velora 15).
 */
function readVolumeFeeBps(): number {
  const raw = Number(process.env.REACT_APP_OPHIS_VOLUME_FEE_BPS)
  return Number.isInteger(raw) && raw >= 1 && raw <= 50 ? raw : 0
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
