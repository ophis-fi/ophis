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
 *                    panel. Perks with an in-app `code`/`redeemUrl` show the
 *                    code plus a shop link; partner-fulfilled perks render
 *                    RewardClaimForm, which records the claim (address + email)
 *                    so the partner has a list to issue codes from.
 *
 * The reward only unblocks AFTER the address validation succeeds; eligibility
 * alone (step 2) never reveals redemption content.
 */
import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { areAddressesEqual, getAddressKey } from '@cowprotocol/cow-sdk'
import { useAccountType, useIsSmartContractWallet } from '@cowprotocol/wallet'

import { Badge, TextLink } from 'ophis/ds'

import { useOphisAffiliateSign } from 'modules/affiliate'

import { RewardClaimForm } from './RewardClaimForm'
import { CLAIM_EMAIL, RewardPerk } from './rewards.const'
import * as styledEl from './Rewards.styled'

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

interface RewardClaimModel {
  accountType: ReturnType<typeof useAccountType>
  claim: ClaimState
  isEligible: boolean
  isSmartContractWallet: boolean
  isValidated: boolean
  onClaim: () => Promise<void>
  progressPct: number
}

function useRewardClaim(perk: RewardPerk, xp: number | null, account: string | undefined): RewardClaimModel {
  const sign = useOphisAffiliateSign(account)
  const isSmartContractWallet = !!useIsSmartContractWallet()
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
  useLayoutEffect(() => {
    accountRef.current = account
  }, [account])

  // Normalized address key: a GENUINE wallet switch resets the claim machine
  // (a validation belongs to the address that signed it), but a checksum-only
  // re-emit of the SAME wallet must NOT reset it — otherwise the case-
  // insensitive checks elsewhere are moot because the reset already dropped
  // the validated reward, forcing a re-sign (Codex review). Keying the effect
  // on the canonical address key makes a casing-only change a no-op.
  const accountKey = account ? getAddressKey(account) : undefined
  useEffect(() => {
    setClaim({ step: 'idle' })
  }, [accountKey])

  const isEligible = account !== undefined && xp !== null && xp >= perk.xpRequired
  // Compare addresses case-insensitively: a reconnect can re-emit the same
  // wallet with different checksum casing (Codex review).
  const isValidated = claim.step === 'validated' && !!areAddressesEqual(claim.wallet, account)
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

  return { accountType, claim, isEligible, isSmartContractWallet, isValidated, onClaim, progressPct }
}

function ValidatedReward({
  claim,
  perk,
}: {
  claim: Extract<ClaimState, { step: 'validated' }>
  perk: RewardPerk
}): ReactNode {
  const claimNote = perk.code
    ? perk.redeemUrl
      ? 'Use this link and enter the code above at checkout to get your discount.'
      : 'Enter the code above at checkout to get your discount.'
    : 'Shop through this link to get your discount.'

  return (
    <styledEl.ClaimPanel>
      <p>
        Address <strong>{truncateAddress(claim.wallet)}</strong> validated. Your reward is unlocked.
      </p>
      {perk.code || perk.redeemUrl ? (
        <>
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
          <styledEl.ClaimNote>{claimNote}</styledEl.ClaimNote>
        </>
      ) : (
        <RewardClaimForm perk={perk} wallet={claim.wallet} issued={claim.issued} signature={claim.signature} />
      )}
    </styledEl.ClaimPanel>
  )
}

interface RewardFooterProps {
  model: RewardClaimModel
  perk: RewardPerk
  xp: number | null
}

function RewardFooter({ model, perk, xp }: RewardFooterProps): ReactNode {
  if (!model.isEligible) {
    return (
      <>
        <styledEl.ProgressTrack aria-hidden="true">
          <styledEl.ProgressFill $pct={model.progressPct} />
        </styledEl.ProgressTrack>
        <styledEl.ProgressLabel>
          {xp === null
            ? `Unlocks at ${formatXp(perk.xpRequired)} XP`
            : `${formatXp(xp)} / ${formatXp(perk.xpRequired)} XP`}
        </styledEl.ProgressLabel>
      </>
    )
  }
  if (model.isValidated && model.claim.step === 'validated') {
    return <ValidatedReward claim={model.claim} perk={perk} />
  }
  if (model.isSmartContractWallet) {
    return (
      <styledEl.ClaimPanel>
        <styledEl.ClaimNote>
          Smart-contract wallets are not supported for signature claims yet. Email{' '}
          <TextLink href={`mailto:${CLAIM_EMAIL}`}>{CLAIM_EMAIL}</TextLink> from your project contact and include your
          Safe address; eligibility is checked on-chain.
        </styledEl.ClaimNote>
      </styledEl.ClaimPanel>
    )
  }
  if (model.accountType === undefined) {
    return (
      <styledEl.ClaimPanel>
        <styledEl.ClaimActionButton type="button" disabled>
          Checking wallet...
        </styledEl.ClaimActionButton>
      </styledEl.ClaimPanel>
    )
  }

  return (
    <styledEl.ClaimPanel>
      <styledEl.ClaimActionButton type="button" onClick={model.onClaim} disabled={model.claim.step === 'validating'}>
        {model.claim.step === 'validating' ? 'Validating address...' : 'Claim reward'}
      </styledEl.ClaimActionButton>
      {model.claim.step === 'rejected' && (
        <styledEl.ClaimNote>
          Signature declined. Claiming needs a one-time signature to validate your address.
        </styledEl.ClaimNote>
      )}
      {model.claim.step === 'error' && <styledEl.ClaimNote>Validation did not complete. Try again.</styledEl.ClaimNote>}
      {model.claim.step === 'idle' && (
        <styledEl.ClaimNote>
          A one-time signature validates that you own this address. No transaction, no gas.
        </styledEl.ClaimNote>
      )}
    </styledEl.ClaimPanel>
  )
}

export function RewardCard({ perk, xp, account }: RewardCardProps): ReactNode {
  const model = useRewardClaim(perk, xp, account)

  const badge = !model.isEligible ? (
    <Badge tone="planned">{`${formatXp(perk.xpRequired)} XP`}</Badge>
  ) : model.isValidated ? (
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
        <RewardFooter model={model} perk={perk} xp={xp} />
      </styledEl.PerkFooter>
    </styledEl.PerkCard>
  )
}
