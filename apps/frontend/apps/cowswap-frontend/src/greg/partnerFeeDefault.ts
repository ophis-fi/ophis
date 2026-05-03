/**
 * Greg partner-fee defaults — duplicated from `@greg/sdk` because the cowswap
 * fork lives in its own pnpm workspace and cannot import from the outer
 * monorepo.
 *
 * Source of truth: `packages/sdk/src/partner-fee.ts`. Keep these values in
 * sync. Whenever `@greg/sdk` changes, mirror the change here in the same PR.
 *
 * See docs/superpowers/specs/2026-05-03-greg-design-amendment.md for the
 * partner-fee strategy. See https://docs.cow.fi/governance/fees/partner-fee
 * for the protocol-level mechanism.
 */

import type { PartnerFee } from '@cowprotocol/widget-lib'

/** Recipient EOA — generated 2026-05-03, key in macOS Keychain entry `greg-partner-fee-recipient`. */
const GREG_PARTNER_FEE_RECIPIENT = '0xBA6Da6bB0fc6A3fABd69A3FCEb25Af4A35a8C76E' as const

/** Default fee in basis points. 1 bps = 0.01%. CoW caps partner fees at 100 bps. */
const GREG_PARTNER_FEE_BPS = 5

/** Default partner-fee config applied to every order on this deployment when no widget partnerFee is provided. */
export const GREG_DEFAULT_PARTNER_FEE: PartnerFee = {
  bps: GREG_PARTNER_FEE_BPS,
  recipient: GREG_PARTNER_FEE_RECIPIENT,
}
