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
]
