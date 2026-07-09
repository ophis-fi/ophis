/**
 * Cash Prize perk catalog. Adding a perk = adding an entry here.
 *
 * XP economics: 1 XP per $1 of the wallet's own lifetime fee-bearing volume
 * (GET rebates.ophis.fi/xp/:wallet). Perks unlock at `xpRequired` and never
 * re-lock (XP is cumulative).
 */

export const XP_PER_USD = 1

export const CLAIM_EMAIL = 'contact@ophis.fi'

export interface CashPrizePerk {
  id: string
  partner: string
  partnerUrl: string
  title: string
  description: string
  xpRequired: number
}

export const CASH_PRIZE_PERKS: CashPrizePerk[] = [
  {
    id: 'octav-20',
    partner: 'Octav',
    partnerUrl: 'https://octav.fi',
    title: '20% off any Octav subscription',
    description:
      'Octav is a portfolio, treasury, and transaction analytics platform for DeFi teams. Unlock a 20% discount on any subscription plan.',
    xpRequired: 5_000,
  },
]
