/**
 * Rewards catalog. Adding a reward = adding an entry here.
 *
 * XP economics: 1 XP per $1 of the wallet's own lifetime fee-bearing volume
 * (GET rebates.ophis.fi/xp/:wallet). A reward unlocks at `xpRequired` and
 * never re-locks (XP is cumulative). Claiming requires validating the
 * connected address: an eligibility check against the threshold plus an
 * ownership signature (see RewardCardView in Rewards.container.tsx).
 */

export const XP_PER_USD = 1

export const CLAIM_EMAIL = 'contact@ophis.fi'

export interface RewardPerk {
  id: string
  partner: string
  partnerUrl: string
  /** Path under public/ to the partner's logo (light variant for the dark card). */
  logo: string
  title: string
  description: string
  xpRequired: number
  /**
   * Self-service redemption. When set, the validated panel shows the code and a
   * CTA to `redeemUrl` in place of the email-claim flow (the "partner codes
   * wired into the app" path noted in RewardCard).
   *
   * SECURITY: the signature gates only the on-page reveal. These values ship in
   * the client bundle, so use them ONLY for public, shareable partner codes
   * (e.g. a broadcast affiliate code) — never a secret or per-address code. A
   * gated secret would need a server that releases it after verifying the
   * signature. Provide either, both, or neither. Perks without these (e.g.
   * Octav) keep the email-claim flow unchanged.
   */
  code?: string
  redeemUrl?: string
  /** CTA label for `redeemUrl`; defaults to `Shop {partner}`. */
  redeemLabel?: string
}

export const REWARDS_PERKS: RewardPerk[] = [
  {
    id: 'octav-20',
    partner: 'Octav',
    partnerUrl: 'https://octav.fi',
    logo: '/logos/octav.svg',
    title: '20% off any Octav subscription',
    description:
      'Octav is a portfolio, treasury, and transaction analytics platform for DeFi teams. Unlock a 20% discount on any subscription plan.',
    xpRequired: 50_000,
  },
  {
    id: 'keystone-5',
    partner: 'Keystone',
    partnerUrl: 'https://keyst.one',
    logo: '/logos/keystone.svg',
    title: '5% off any Keystone order',
    description:
      'Keystone is an air-gapped hardware wallet for fully offline, self-custodied key storage. Unlock 5% off your next order.',
    xpRequired: 5_000,
    code: 'OPHIS',
    // Refersion affiliate link: purchases through it are credited to Ophis.
    // No redeemLabel: the default `Shop ${partner}` already yields "Shop Keystone".
    redeemUrl:
      'https://keyst.one/?rfsn=9229963.b1e88c&utm_source=refersion&utm_medium=affiliate&utm_campaign=9229963.b1e88c',
  },
]
