/**
 * Server-side reward catalog.
 *
 * MUST stay in sync with the frontend catalog at
 * apps/frontend/apps/cowswap-frontend/src/pages/Rewards/rewards.const.ts —
 * the frontend copy drives what is RENDERED, this copy is the AUTHORITY for
 * what can be CLAIMED. The XP threshold is duplicated on purpose: the claim
 * endpoint must never take an eligibility threshold (or an XP balance) from the
 * client, so it re-checks against this table using its own indexed volume.
 *
 * `partnerFulfilled` marks perks whose code is issued by the partner from the
 * claim list (Octav). Perks that ship a public code + affiliate link in the
 * client bundle (Keystone) are self-service: there is nothing to collect, so
 * the claim endpoint rejects them rather than storing an email with no purpose.
 */

export interface RewardCatalogEntry {
  readonly id: string;
  readonly partner: string;
  /** XP (= $1 of lifetime fee-bearing volume) required to unlock. */
  readonly xpRequired: number;
  /** Code issued by the partner from the collected claim list. */
  readonly partnerFulfilled: boolean;
}

export const REWARD_CATALOG: readonly RewardCatalogEntry[] = [
  { id: 'octav-20', partner: 'Octav', xpRequired: 50_000, partnerFulfilled: true },
  { id: 'keystone-5', partner: 'Keystone', xpRequired: 5_000, partnerFulfilled: false },
];

export function findReward(id: string): RewardCatalogEntry | undefined {
  return REWARD_CATALOG.find((r) => r.id === id);
}
