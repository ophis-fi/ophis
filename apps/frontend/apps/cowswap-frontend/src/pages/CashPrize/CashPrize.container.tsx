/**
 * Cash Prize — partner perks unlocked with XP.
 *
 * XP = the connected wallet's lifetime fee-bearing volume, 1 XP per $1,
 * read from GET rebates.ophis.fi/xp/:wallet (public, no signature). Perks
 * are listed in cashPrize.const.ts; each unlocks at its XP threshold and
 * stays unlocked (XP is cumulative and never expires).
 *
 * Claiming: until partner discount codes are wired into the app, an
 * unlocked perk is claimed by email; the claim link pre-fills the wallet
 * so the team can check the on-chain XP before sending the code.
 *
 * AGENTS.md compliance: named export, page impl in *.container.tsx,
 * styles in CashPrize.styled.ts, <250 LOC.
 */
import { ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Badge, Callout, PageShell, Section, TextLink } from 'ophis/ds'

import { ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import * as styledEl from './CashPrize.styled'
import { CASH_PRIZE_PERKS, CLAIM_EMAIL, CashPrizePerk } from './cashPrize.const'
import { useWalletXp } from './useWalletXp'
import { XpRing } from './XpRing'

function formatXp(value: number): string {
  return value.toLocaleString('en-US')
}

function claimHref(perk: CashPrizePerk, account: string): string {
  const subject = `Cash Prize claim: ${perk.title}`
  const body = `Perk: ${perk.id}\nWallet: ${account}\n\nPlease send my ${perk.partner} discount code to this email address.`
  return `mailto:${CLAIM_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

interface PerkCardProps {
  perk: CashPrizePerk
  xp: number | null
  account: string | undefined
}

function PerkCardView({ perk, xp, account }: PerkCardProps): ReactNode {
  const unlocked = xp !== null && xp >= perk.xpRequired
  const progressPct = xp === null ? 0 : (xp / perk.xpRequired) * 100

  return (
    <styledEl.PerkCard>
      <styledEl.PerkHeader>
        <styledEl.PerkPartner>{perk.partner}</styledEl.PerkPartner>
        <Badge tone={unlocked ? 'live' : 'planned'}>
          {unlocked ? 'Unlocked' : `${formatXp(perk.xpRequired)} XP`}
        </Badge>
      </styledEl.PerkHeader>
      <styledEl.PerkTitle>{perk.title}</styledEl.PerkTitle>
      <styledEl.PerkDescription>
        {perk.description}{' '}
        <TextLink href={perk.partnerUrl} external>
          {perk.partnerUrl.replace('https://', '')}
        </TextLink>
      </styledEl.PerkDescription>
      <styledEl.PerkFooter>
        {unlocked && account ? (
          <styledEl.ClaimButton href={claimHref(perk, account)}>Claim your discount</styledEl.ClaimButton>
        ) : (
          <>
            <styledEl.ProgressTrack aria-hidden="true">
              <styledEl.ProgressFill $pct={progressPct} />
            </styledEl.ProgressTrack>
            <styledEl.ProgressLabel>
              {xp === null ? `Unlocks at ${formatXp(perk.xpRequired)} XP` : `${formatXp(xp)} / ${formatXp(perk.xpRequired)} XP`}
            </styledEl.ProgressLabel>
          </>
        )}
      </styledEl.PerkFooter>
    </styledEl.PerkCard>
  )
}

export function CashPrizePage(): ReactNode {
  const { account } = useWalletInfo()
  const { data, loading, error } = useWalletXp(account)
  // Loading covers the pre-fetch frame too (connected, no data, no error yet)
  // so a "0 XP" never flashes before the real balance.
  const isXpLoading = loading || (Boolean(account) && !data && !error)

  const xp = data?.xp ?? null
  const lockedThresholds = CASH_PRIZE_PERKS.filter((p) => xp === null || xp < p.xpRequired).map((p) => p.xpRequired)
  const nextUnlockXp = lockedThresholds.length ? Math.min(...lockedThresholds) : null

  return (
    <PageShell
      width="medium"
      eyebrow="Cash Prize"
      title="Trade. Earn XP. Unlock partner perks."
      lede="Every dollar of volume you trade on Ophis earns 1 XP. XP unlocks Cash Prize perks from partners, and it never expires."
    >
      <Section id="xp" title="Your XP">
        {!account ? (
          <Callout tone="info" title="Connect a wallet">
            <p>
              XP is read from your trading history on the public rebate indexer. Connect a wallet to
              see your balance and unlock perks. Nothing to sign, nothing stored by Ophis.
            </p>
            <ConnectWalletCta />
          </Callout>
        ) : isXpLoading ? (
          <p>Loading your XP...</p>
        ) : error ? (
          <Callout tone="warning" title="Could not load your XP">
            <p>The rebate indexer did not respond. Refresh the page to try again.</p>
          </Callout>
        ) : (
          <styledEl.XpRow>
            <XpRing xp={xp ?? 0} nextUnlockXp={nextUnlockXp} />
            <styledEl.XpFacts>
              <p>
                <strong>{formatXp(xp ?? 0)} XP</strong> from{' '}
                {(data?.lifetimeVolumeUsd ?? 0).toLocaleString('en-US', {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 0,
                })}{' '}
                of lifetime volume.
              </p>
              {nextUnlockXp !== null ? (
                <p>
                  {formatXp(Math.max(nextUnlockXp - (xp ?? 0), 0))} XP to your next unlock. Every swap
                  counts: $1 traded = 1 XP, on any supported chain.
                </p>
              ) : (
                <p>All current perks are unlocked. New perks are added as partners join.</p>
              )}
            </styledEl.XpFacts>
          </styledEl.XpRow>
        )}
      </Section>

      <Section id="perks" title="Perks">
        <styledEl.PerkGrid>
          {CASH_PRIZE_PERKS.map((perk) => (
            <PerkCardView key={perk.id} perk={perk} xp={xp} account={account} />
          ))}
        </styledEl.PerkGrid>
      </Section>

      <Section id="how-it-works" title="How it works">
        <ul>
          <li>$1 of traded volume = 1 XP, counted across all production chains. Fee-free flows do not earn XP.</li>
          <li>XP is cumulative and never expires. Perks stay unlocked once you reach the threshold.</li>
          <li>
            Claims are answered by email after a quick XP check. Partners who want to list a perk can{' '}
            <TextLink href={`mailto:${CLAIM_EMAIL}`}>get in touch</TextLink>.
          </li>
        </ul>
      </Section>
    </PageShell>
  )
}
