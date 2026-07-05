import type { OwnFeeOwed } from './accrual.js';
import { OPHIS_SAFE_LOWER, ZERO_ADDRESS_LOWER } from './recipients.js';

// Pure sovereign own-fee payout planning -- NO db / network imports, so it is
// unit-testable in isolation (the I/O executor lives in payout.ts). Mirrors
// affiliate/payoutPlan.ts.

/**
 * Default-OFF, fail-loud flag gating the sovereign own-fee PAYOUT (Safe proposal). The
 * accrual + ledger still compute + record regardless; only the on-chain proposal is
 * gated, so the deploy stays inert until the operator flips it. Same parser shape as
 * resolveAffiliatePayoutEnabled.
 */
export function resolveOwnFeePayoutEnabled(): boolean {
  const raw = process.env.OWN_FEE_PAYOUT_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`OWN_FEE_PAYOUT_ENABLED must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

export interface OwnFeeTransfer {
  /** The allowlisted own-fee recipient = the on-chain WETH payout address. */
  readonly to: `0x${string}`;
  readonly amount: bigint;
}
export interface OwnFeePlan {
  readonly transfers: readonly OwnFeeTransfer[];
  readonly totalOwedWei: bigint;
  readonly blocked: boolean;
  readonly reason?: string;
}

/**
 * Pure: turn computed owed amounts into a payout plan, with the OVER-DRAW GUARD. Own-fee
 * is paid from that sovereign chain's Ophis Safe; the total owed must fit within the
 * Safe's WETH balance on that chain, else the plan is BLOCKED (no proposal made) and the
 * caller alerts LOUD. Zero-amount, zero-address and Ophis-Safe recipients are dropped
 * (defense-in-depth behind the allowlist, since the recipient IS the money path).
 */
export function planOwnFeePayout(owed: readonly OwnFeeOwed[], safeBalanceWei: bigint): OwnFeePlan {
  const valid = owed.filter((o) => {
    const to = o.recipient.toLowerCase();
    return o.owedWei > 0n && to !== ZERO_ADDRESS_LOWER && to !== OPHIS_SAFE_LOWER;
  });
  const totalOwedWei = valid.reduce((acc, o) => acc + o.owedWei, 0n);
  if (totalOwedWei > safeBalanceWei) {
    return {
      transfers: [],
      totalOwedWei,
      blocked: true,
      reason: 'own-fee owed exceeds the Safe WETH balance on this chain',
    };
  }
  const transfers = valid.map((o) => ({ to: o.recipient, amount: o.owedWei }));
  return { transfers, totalOwedWei, blocked: false };
}
