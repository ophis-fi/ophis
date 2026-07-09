/**
 * RewardCard — one partner reward with the claim state machine.
 *
 * Claim flow (in order):
 *   1. locked      : connected address below the XP threshold -> progress bar.
 *   2. eligible    : address meets the threshold -> "Claim reward" CTA.
 *   3. validating  : ownership check - the address signs `claim reward <id>`
 *                    (EIP-191, same message shape as every other Ophis signed
 *                    action, so the team can recover and verify the signer).
 *   4. validated   : the reward is unblocked for that address -> redemption
 *                    panel (email request carrying the signed proof, until
 *                    partner codes are wired into the app).
 *
 * The reward only unblocks AFTER the address validation succeeds; eligibility
 * alone (step 2) never reveals redemption content.
 */
import { ReactNode, useCallback, useState } from 'react'

import { useOphisAffiliateSign } from 'modules/affiliate'

import * as styledEl from './Rewards.styled'
import { CLAIM_EMAIL, RewardPerk } from './rewards.const'

import { Badge, TextLink } from 'ophis/ds'

function formatXp(value: number): string {
  return value.toLocaleString('en-US')
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function claimHref(perk: RewardPerk, account: string, issued: number, signature: string): string {
  const subject = `Reward claim: ${perk.title}`
  const body = [
    `Reward: ${perk.id}`,
    `Address: ${account}`,
    `Issued: ${issued}`,
    `Signature: ${signature}`,
    '',
    `Please send my ${perk.partner} discount code to this email address.`,
  ].join('\n')
  return `mailto:${CLAIM_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

type ClaimState =
  | { step: 'idle' }
  | { step: 'validating' }
  | { step: 'validated'; issued: number; signature: string }
  | { step: 'rejected' }
  | { step: 'error' }

interface RewardCardProps {
  perk: RewardPerk
  xp: number | null
  account: string | undefined
}

export function RewardCard({ perk, xp, account }: RewardCardProps): ReactNode {
  const sign = useOphisAffiliateSign(account)
  const [claim, setClaim] = useState<ClaimState>({ step: 'idle' })

  const isEligible = account !== undefined && xp !== null && xp >= perk.xpRequired
  const progressPct = xp === null ? 0 : (xp / perk.xpRequired) * 100

  const onClaim = useCallback(async () => {
    // Re-check eligibility at click time: the CTA only renders when eligible,
    // but a wallet switch could land between render and click.
    if (!isEligible || !account) return
    setClaim({ step: 'validating' })
    try {
      const signed = await sign(`claim reward ${perk.id}`)
      setClaim({ step: 'validated', issued: signed.issued, signature: signed.signature })
    } catch (error: unknown) {
      const code = (error as { code?: number | string })?.code
      setClaim(code === 4001 || code === 'ACTION_REJECTED' ? { step: 'rejected' } : { step: 'error' })
    }
  }, [account, isEligible, perk.id, sign])

  const badge = !isEligible ? (
    <Badge tone="planned">{`${formatXp(perk.xpRequired)} XP`}</Badge>
  ) : claim.step === 'validated' ? (
    <Badge tone="live">Unlocked</Badge>
  ) : (
    <Badge tone="live">Eligible</Badge>
  )

  return (
    <styledEl.PerkCard>
      <styledEl.PerkHeader>
        <styledEl.PartnerLogo src={perk.logo} alt={perk.partner} />
        {badge}
      </styledEl.PerkHeader>
      <styledEl.PerkTitle>{perk.title}</styledEl.PerkTitle>
      <styledEl.PerkDescription>
        {perk.description}{' '}
        <TextLink href={perk.partnerUrl} external>
          {perk.partnerUrl.replace('https://', '')}
        </TextLink>
      </styledEl.PerkDescription>
      <styledEl.PerkFooter>
        {!isEligible ? (
          <>
            <styledEl.ProgressTrack aria-hidden="true">
              <styledEl.ProgressFill $pct={progressPct} />
            </styledEl.ProgressTrack>
            <styledEl.ProgressLabel>
              {xp === null
                ? `Unlocks at ${formatXp(perk.xpRequired)} XP`
                : `${formatXp(xp)} / ${formatXp(perk.xpRequired)} XP`}
            </styledEl.ProgressLabel>
          </>
        ) : claim.step === 'validated' ? (
          <styledEl.ClaimPanel>
            <p>
              Address <strong>{truncateAddress(account)}</strong> validated. Your reward is unlocked.
            </p>
            <styledEl.ClaimButton href={claimHref(perk, account, claim.issued, claim.signature)}>
              Request your code by email
            </styledEl.ClaimButton>
            <styledEl.ClaimNote>
              The email includes your signed proof; the {perk.partner} code is sent back after a quick check.
            </styledEl.ClaimNote>
          </styledEl.ClaimPanel>
        ) : (
          <styledEl.ClaimPanel>
            <styledEl.ClaimActionButton
              type="button"
              onClick={onClaim}
              disabled={claim.step === 'validating'}
            >
              {claim.step === 'validating' ? 'Validating address...' : 'Claim reward'}
            </styledEl.ClaimActionButton>
            {claim.step === 'rejected' && (
              <styledEl.ClaimNote>Signature declined. Claiming needs a one-time signature to validate your address.</styledEl.ClaimNote>
            )}
            {claim.step === 'error' && (
              <styledEl.ClaimNote>Validation did not complete. Try again.</styledEl.ClaimNote>
            )}
            {claim.step === 'idle' && (
              <styledEl.ClaimNote>A one-time signature validates that you own this address. No transaction, no gas.</styledEl.ClaimNote>
            )}
          </styledEl.ClaimPanel>
        )}
      </styledEl.PerkFooter>
    </styledEl.PerkCard>
  )
}
