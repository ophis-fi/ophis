import { DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK } from '@cowprotocol/common-const'

/**
 * Returns true if an order placed on `chainId` through the Ophis frontend
 * should embed Ophis's CIP-75 partner-fee metadata. The recipient is the
 * canonical Ophis Safe, set in `ophis/partnerFeeDefault.ts` (a single const,
 * correct on every chain — the Safe is CREATE2-deterministic).
 *
 * Revenue model (Clement, 2026-05-27): Ophis earns the partner fee on EVERY
 * chain its frontend serves — the original Phase-1.5 "all CoW chains" model.
 * Canonical CoW chains settle via api.cow.fi + CoW's solver network (CoW
 * disburses 75% weekly); Ophis-operated chains (10/4326/999) settle on our
 * own stack (100%, no CoW cut).
 *
 * History: the Phase-3 H3 gate restricted emission to chains whose entry in
 * `DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK` *equals* the Ophis recipient —
 * only 10/4326/999. That cut canonical-chain revenue (confirmed over-
 * correction). We now gate on chain SUPPORT (map membership), not the
 * recipient value:
 *   - The per-network map stays the THIRD-PARTY widget-configurator default
 *     (CoW placeholder for canonical chains), so a third-party widget embed
 *     never unknowingly routes fees to Ophis. That concern is moot for our
 *     own deployment (we don't ship apps/widget-configurator), but the map +
 *     its MED-3 test are left intact for correctness.
 *   - Membership gating is also immune to the MED-1 recipient-casing leak:
 *     we never compare the recipient string here, so a lowercase map edit
 *     can't silently flip the gate to false.
 */
export function shouldEmitOphisPartnerFee(chainId: number | undefined): boolean {
  if (chainId === undefined) return false
  // Emit on any chain present in the per-network map = all CoW-supported
  // chains + Ophis-operated 10/4326/999. Chains absent from the map (i.e.
  // not served) return undefined → no fee.
  const recipient = (DEFAULT_PARTNER_FEE_RECIPIENT_PER_NETWORK as Record<number, string>)[chainId]
  return recipient !== undefined
}
