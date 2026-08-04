/**
 * RewardCard: one partner reward, with two distinct claim paths.
 *
 * Both start the same way: below the XP threshold the card shows a progress
 * bar, and nothing is revealed on eligibility alone. What follows depends on
 * how the perk is fulfilled.
 *
 * SELF-SERVICE perks (an in-app `code` / `redeemUrl`) keep the sign-to-reveal
 * machine that lives here: "Claim reward" -> the address signs
 * `claim reward <id>` -> the code and shop link appear. The signature is the
 * gate on revealing content, so it has to come first.
 *
 * PARTNER-FULFILLED perks (neither field) delegate to RewardClaimForm, which
 * collects the email BEFORE signing, because the signed message binds the
 * destination (`claim reward <id> for <email>`). There is nothing to reveal
 * here, so a pre-signature would only produce a proof that goes stale in an
 * open form and cannot cover where the code gets mailed.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'
import { useAccountType, useIsSmartContractWallet } from '@cowprotocol/wallet'

import { useOphisAffiliateSign } from 'modules/affiliate'

import { RewardClaimForm } from './RewardClaimForm'
import * as styledEl from './Rewards.styled'
import { CLAIM_EMAIL, RewardPerk } from './rewards.const'

import { Badge, TextLink } from 'ophis/ds'

function formatXp(value: number): string {
  return value.toLocaleString('en-US')
}

function truncateAddress(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
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
  // Partner-fulfilled perks own their flow in RewardClaimForm; this only drives
  // the badge once that form reports a recorded claim.
  const [claimRecorded, setClaimRecorded] = useState(false)

  // Latest account, for guarding async claim continuations against a wallet
  // switch that lands while the signature prompt is pending.
  const accountRef = useRef(account)
  accountRef.current = account

  // Normalized address key: a GENUINE wallet switch resets the claim machine
  // (a validation belongs to the address that signed it), but a checksum-only
  // re-emit of the SAME wallet must NOT reset it — otherwise the case-
  // insensitive checks elsewhere are moot because the reset already dropped
  // the validated reward, forcing a re-sign (Codex review). Keying the effect
  // on the canonical address key makes a casing-only change a no-op.
  const accountKey = account ? getAddressKey(account) : undefined
  useEffect(() => {
    setClaim({ step: 'idle' })
    setClaimRecorded(false)
  }, [accountKey])

  // Perks that ship a redeemable code in the bundle are self-service; the rest
  // are issued by the partner from the claim list.
  const isSelfService = Boolean(perk.code || perk.redeemUrl)

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
      // Self-service only: this signature gates the on-page reveal and is never
      // sent anywhere, so it stays the bare `claim reward <id>`. The backend's
      // claim endpoint accepts only the email-bound form and rejects
      // self-service rewards outright, so this can never authorize a claim.
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
  ) : isValidated || claimRecorded ? (
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
        ) : isSelfService && isValidated && claim.step === 'validated' ? (
          <styledEl.ClaimPanel>
            <p>
              Address <strong>{truncateAddress(claim.wallet)}</strong> validated. Your reward is unlocked.
            </p>
            {perk.code && (
              <styledEl.RedeemRow>
                <styledEl.ClaimNote>Code</styledEl.ClaimNote>
                <styledEl.CodeChip>{perk.code}</styledEl.CodeChip>
              </styledEl.RedeemRow>
            )}
            {perk.redeemUrl && (
              <styledEl.ClaimButton href={perk.redeemUrl} target="_blank" rel="noopener noreferrer">
                {perk.redeemLabel ?? `Shop ${perk.partner}`}
              </styledEl.ClaimButton>
            )}
            <styledEl.ClaimNote>
              {perk.code && perk.redeemUrl
                ? 'Use this link and enter the code above at checkout to get your discount.'
                : perk.code
                  ? 'Enter the code above at checkout to get your discount.'
                  : 'Shop through this link to get your discount.'}
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
        ) : !isSelfService && account ? (
          // Partner-fulfilled: the form collects the email, signs a message that
          // BINDS that email, and posts the claim. No pre-signature, so nothing
          // can go stale between validating and submitting.
          <styledEl.ClaimPanel>
            <RewardClaimForm perk={perk} account={account} onClaimed={() => setClaimRecorded(true)} />
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
