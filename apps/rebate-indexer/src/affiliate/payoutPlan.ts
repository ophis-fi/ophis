import type { AffiliateOwed } from './computeAffiliate.js';

// Pure affiliate-payout planning — NO db / network imports, so it is unit-testable
// in isolation (the I/O executor lives in payout.ts).

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Default-OFF, fail-loud flag gating the affiliate PAYOUT (Safe proposal). The
 * monthly report still computes + displays affiliate owed regardless; only the
 * on-chain proposal is gated, so the deploy stays inert until the operator flips it.
 * Mirrors resolveDirectMode/resolveConvertMode in the batcher.
 */
export function resolveAffiliatePayoutEnabled(): boolean {
  const raw = process.env.AFFILIATE_PAYOUT_ENABLED?.trim();
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error(`AFFILIATE_PAYOUT_ENABLED must be 'true', '1', 'false', '0', or unset; got "${raw}"`);
}

export interface AffiliateTransfer {
  readonly to: `0x${string}`;
  readonly amount: bigint;
  readonly kind: 'regular' | 'partner';
  readonly referredVolumeUsd: number;
}
export interface AffiliatePlan {
  readonly transfers: readonly AffiliateTransfer[];
  readonly totalOwedWei: bigint;
  readonly blocked: boolean;
  readonly reason?: string;
}

/**
 * Pure: turn computed owed amounts into a payout plan, with the DOUBLE-SPEND GUARD.
 * Affiliate is paid from the SAME Safe as rebates, so the affiliate total plus the
 * rebate pool already proposed this cycle must fit within the Safe's WETH balance —
 * otherwise the two proposals could together over-draw the Safe. If they would, the
 * plan is BLOCKED (no proposal made) and the caller alerts. Zero-amount and
 * zero-address recipients are dropped.
 */
export function planAffiliatePayout(
  owed: readonly AffiliateOwed[],
  safeBalanceWei: bigint,
  rebatePoolWei: bigint,
): AffiliatePlan {
  const valid = owed.filter((o) => o.owedWei > 0n && o.referrer_wallet.toLowerCase() !== ZERO_ADDRESS);
  const totalOwedWei = valid.reduce((acc, o) => acc + o.owedWei, 0n);
  if (rebatePoolWei + totalOwedWei > safeBalanceWei) {
    return { transfers: [], totalOwedWei, blocked: true, reason: 'rebate pool + affiliate owed exceed the Safe WETH balance' };
  }
  const transfers = valid.map((o) => ({
    to: o.referrer_wallet,
    amount: o.owedWei,
    kind: o.kind,
    referredVolumeUsd: o.referredVolumeUsd,
  }));
  return { transfers, totalOwedWei, blocked: false };
}
