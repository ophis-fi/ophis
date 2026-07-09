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
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'
import { useAccountType, useIsSmartContractWallet } from '@cowprotocol/wallet'

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
  // `wallet` pins the validation to the address that actually signed: the
  // validated branch renders only while that address is still connected.
  | { step: 'validated'; wallet: string; issued: number; signature: string }
  | { step: 'rejected' }
  | { step: 'error' }

interface RewardCardProps {
  perk: RewardPerk
  xp: number | null
  account: string | undefined
}

export function RewardCard({ perk, xp, account }: RewardCardProps): ReactNode {
  const sign = useOphisAffiliateSign(account)
  const isSmartContractWallet = useIsSmartContractWallet()
  // useIsSmartContractWallet() coalesces to `false` while the on-chain code
  // lookup is still pending (a Safe resolves synchronously; a non-Safe
  // contract wallet does not), so it cannot itself signal "still loading".
  // useAccountType() is `undefined` until that getCode check resolves, which
  // is the real loading signal we gate the claim button on (Codex review).
  const accountType = useAccountType()
  const [claim, setClaim] = useState<ClaimState>({ step: 'idle' })

  // Latest account, for guarding async claim continuations against a wallet
  // switch that lands while the signature prompt is pending.
  const accountRef = useRef(account)
  accountRef.current = account

  // Normalized address key: a GENUINE wallet switch resets the claim machine
  // (a validation belongs to the address that signed it), but a checksum-only
  // re-emit of the SAME wallet must NOT reset it — otherwise the case-
  // insensitive checks elsewhere are moot because the reset already dropped
  // the validated reward, forcing a re-sign (Codex review). Keying the effect
  // on the lowercased address makes a casing-only change a no-op.
  const accountKey = account?.toLowerCase()
  useEffect(() => {
    setClaim({ step: 'idle' })
  }, [accountKey])

  const isEligible = account !== undefined && xp !== null && xp >= perk.xpRequired
  // Compare addresses case-insensitively: a reconnect can re-emit the same
  // wallet with different checksum casing (Codex review).
  const isValidated = claim.step === 'validated' && areAddressesEqual(claim.wallet, account)
  const progressPct = xp === null ? 0 : (xp / perk.xpRequired) * 100

  const onClaim = useCallback(async () => {
    // Re-check eligibility at click time: the CTA only renders when eligible,
    // but a wallet switch could land between render and click.
    if (!isEligible || !account) return
    const startAccount = account
    setClaim({ step: 'validating' })
    try {
      const signed = await sign(`claim reward ${perk.id}`)
      // Bail if the wallet actually changed during signing (case-insensitive:
      // a same-wallet reconnect can re-emit different casing). The
      // account-change effect already reset the claim for a genuinely new
      // wallet, so applying A's result here would leak into B's card.
      if (!areAddressesEqual(accountRef.current, startAccount)) return
      setClaim({ step: 'validated', wallet: startAccount, issued: signed.issued, signature: signed.signature })
    } catch (error: unknown) {
      if (!areAddressesEqual(accountRef.current, startAccount)) return
      const code = (error as { code?: number | string })?.code
      setClaim(code === 4001 || code === 'ACTION_REJECTED' ? { step: 'rejected' } : { step: 'error' })
    }
  }, [account, isEligible, perk.id, sign])

  const badge = !isEligible ? (
    <Badge tone="planned">{`${formatXp(perk.xpRequired)} XP`}</Badge>
  ) : isValidated ? (
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
        ) : isValidated && claim.step === 'validated' ? (
          <styledEl.ClaimPanel>
            <p>
              Address <strong>{truncateAddress(claim.wallet)}</strong> validated. Your reward is unlocked.
            </p>
            <styledEl.ClaimButton href={claimHref(perk, claim.wallet, claim.issued, claim.signature)}>
              Request your code by email
            </styledEl.ClaimButton>
            <styledEl.ClaimNote>
              The email includes your signed proof; the {perk.partner} code is sent back after a quick check.
            </styledEl.ClaimNote>
          </styledEl.ClaimPanel>
        ) : isSmartContractWallet ? (
          <styledEl.ClaimPanel>
            {/* Safe and other contract wallets cannot produce the recoverable
                EIP-191 signature the claim check verifies (they sign via
                EIP-1271, which needs an on-chain call to validate). Route
                them to email until a 1271-aware claim path exists. A Safe
                resolves synchronously so it lands here without a loading hold. */}
            <styledEl.ClaimNote>
              Smart-contract wallets are not supported for signature claims yet. Email{' '}
              <TextLink href={`mailto:${CLAIM_EMAIL}`}>{CLAIM_EMAIL}</TextLink> from your project
              contact and include your Safe address; eligibility is checked on-chain.
            </styledEl.ClaimNote>
          </styledEl.ClaimPanel>
        ) : accountType === undefined ? (
          <styledEl.ClaimPanel>
            {/* getCode still resolving for a non-Safe wallet: hold the button
                rather than defaulting to the EOA signature path, so a contract
                wallet can't enter the EIP-191 flow before detection completes
                (Codex review). Fail-closed if the lookup errors. */}
            <styledEl.ClaimActionButton type="button" disabled>
              Checking wallet...
            </styledEl.ClaimActionButton>
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
