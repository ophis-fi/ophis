/**
 * Rewards — partner rewards unlocked with XP.
 *
 * XP = the connected wallet's lifetime fee-bearing volume, 1 XP per $1,
 * read from GET rebates.ophis.fi/xp/:wallet (public, no signature). Rewards
 * are listed in rewards.const.ts; each unlocks at its XP threshold and
 * stays unlocked (XP is cumulative and never expires).
 *
 * Claiming lives in RewardCard.tsx: eligibility check on the connected
 * address, then an ownership signature; the reward unblocks only after the
 * address validation succeeds.
 *
 * AGENTS.md compliance: named export, page impl in *.container.tsx,
 * styles in Rewards.styled.ts, <250 LOC.
 */
import { ReactNode } from 'react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { Callout, PageShell, Section, TextLink } from 'ophis/ds'

import { ConnectWalletCta } from 'pages/Affiliate/ConnectWalletCta'

import { RewardCard } from './RewardCard'
import * as styledEl from './Rewards.styled'
import { CLAIM_EMAIL, REWARDS_PERKS } from './rewards.const'
import { useWalletXp } from './useWalletXp'
import { XpRing } from './XpRing'

function formatXp(value: number): string {
  return value.toLocaleString('en-US')
}

export function RewardsPage(): ReactNode {
  const { account } = useWalletInfo()
  const { data, loading, error } = useWalletXp(account)
  // Loading covers the pre-fetch frame too (connected, no data, no error yet)
  // so a "0 XP" never flashes before the real balance.
  const isXpLoading = loading || (Boolean(account) && !data && !error)

  const xp = data?.xp ?? null
  const lockedThresholds = REWARDS_PERKS.filter((p) => xp === null || xp < p.xpRequired).map((p) => p.xpRequired)
  const nextUnlockXp = lockedThresholds.length ? Math.min(...lockedThresholds) : null

  return (
    <PageShell
      width="medium"
      eyebrow="Rewards"
      title="Trade. Earn XP. Unlock rewards."
      lede="Every dollar of volume you trade on Ophis earns 1 XP. XP unlocks rewards from partners, and it never expires."
    >
      <Section id="xp" title="Your XP">
        {!account ? (
          <Callout tone="info" title="Connect a wallet">
            <p>
              XP is read from your trading history on the public rebate indexer. Connect a wallet to
              see your balance and unlock rewards. Nothing to sign, nothing stored by Ophis.
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
                <p>All current rewards are unlocked. New rewards are added as partners join.</p>
              )}
            </styledEl.XpFacts>
          </styledEl.XpRow>
        )}
      </Section>

      <Section id="rewards" title="Rewards">
        <styledEl.PerkGrid>
          {REWARDS_PERKS.map((perk) => (
            <RewardCard key={perk.id} perk={perk} xp={xp} account={account} />
          ))}
        </styledEl.PerkGrid>
      </Section>

      <Section id="how-it-works" title="How it works">
        <ul>
          <li>$1 of traded volume = 1 XP, counted across all production chains. Fee-free flows do not earn XP.</li>
          <li>XP is cumulative and never expires. Rewards stay unlocked once you reach the threshold.</li>
          <li>
            Claiming validates your address: an eligibility check against the threshold, then a
            one-time signature. No transaction, no gas.
          </li>
          <li>
            Partners who want to list a reward can <TextLink href={`mailto:${CLAIM_EMAIL}`}>get in touch</TextLink>.
          </li>
        </ul>
      </Section>
    </PageShell>
  )
}
