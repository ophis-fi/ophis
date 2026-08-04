/**
 * RewardClaimForm: email capture + signed claim for partner-fulfilled perks.
 *
 * Why it exists: perks like Octav have no in-app code. The partner issues the
 * codes, which means Ophis has to hand them a list of who claimed. The original
 * flow ended at a `mailto:` link, so a claim only existed if the visitor
 * actually sent the pre-filled mail; there was no claim list at all. This posts
 * the claim to the rebate indexer (POST /rewards/claim), which re-checks
 * eligibility server-side and records (address, email) for the hand-off.
 *
 * ORDER IS LOAD-BEARING: the email is collected FIRST, then signed, then sent.
 * The signed message is `claim reward <id> for <email>`, so the proof covers the
 * destination the code gets mailed to. Signing before knowing the email (the
 * shape this component originally had) would leave the address unsigned, and a
 * signature captured inside the 5-minute replay window could be replayed with
 * an attacker's address swapped in: the victim's wallet proves eligibility, the
 * attacker receives the code.
 *
 * Signing at submit time also means the signature is spent milliseconds after it
 * is produced, so it cannot go stale sitting in an open form. Every failure here
 * leaves the form intact and retryable; there is no state the user has to
 * refresh out of.
 *
 * The email is collected for one purpose only: contacting the claimer about
 * this reward, i.e. the partner sending the code. The form says so.
 *
 * The mailto stays as the FALLBACK for a failed POST: a claimer whose request is
 * blocked (offline, CORS, indexer down) can still reach a human, so a backend
 * outage never strands an eligible reward.
 */
import { FormEvent, ReactNode, useCallback, useRef, useState } from 'react'

import { areAddressesEqual } from '@cowprotocol/cow-sdk'

import { AffiliateApiError, submitRewardClaim, useOphisAffiliateSign } from 'modules/affiliate'

import * as styledEl from './Rewards.styled'
import { CLAIM_EMAIL, RewardPerk } from './rewards.const'

import { TextLink } from 'ophis/ds'

/** Signed proof kept only to build the fallback mail after a failed POST. */
interface SignedProof {
  issued: number
  signature: string
}

type SubmitState =
  | { step: 'idle' }
  | { step: 'signing' }
  | { step: 'sending' }
  | { step: 'done'; email: string; alreadyClaimed: boolean }
  // `proof` is present only when the signature succeeded and the POST failed,
  // which is exactly when the fallback mail can carry a usable proof.
  | { step: 'error'; message: string; proof?: SignedProof }

interface RewardClaimFormProps {
  perk: RewardPerk
  account: string
  /** Lets the card flip its badge to "Unlocked" once a claim lands. */
  onClaimed: () => void
}

/** Pre-filled fallback mail, carrying the same signed proof the POST would have. */
function claimHref(perk: RewardPerk, account: string, email: string, proof: SignedProof): string {
  const subject = `Reward claim: ${perk.title}`
  const body = [
    `Reward: ${perk.id}`,
    `Address: ${account}`,
    `Email: ${email}`,
    `Issued: ${proof.issued}`,
    `Signature: ${proof.signature}`,
    '',
    `Please send my ${perk.partner} discount code to this email address.`,
  ].join('\n')
  return `mailto:${CLAIM_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export function RewardClaimForm({ perk, account, onClaimed }: RewardClaimFormProps): ReactNode {
  const sign = useOphisAffiliateSign(account)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<SubmitState>({ step: 'idle' })

  // Guards the async continuations against a wallet switch landing while the
  // signature prompt is open, so one wallet's claim can never be attributed to
  // whichever wallet happens to be connected when the promise resolves.
  const accountRef = useRef(account)
  accountRef.current = account

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>): Promise<void> => {
      e.preventDefault()
      if (state.step === 'signing' || state.step === 'sending') return

      // Sign and send the SAME string, so the backend's byte-match holds.
      const trimmed = email.trim()
      const startAccount = account
      setState({ step: 'signing' })

      let proof: SignedProof
      try {
        const signed = await sign(`claim reward ${perk.id} for ${trimmed}`)
        if (!areAddressesEqual(accountRef.current, startAccount)) return
        proof = { issued: signed.issued, signature: signed.signature }
      } catch (error: unknown) {
        if (!areAddressesEqual(accountRef.current, startAccount)) return
        const code = (error as { code?: number | string })?.code
        setState({
          step: 'error',
          message:
            code === 4001 || code === 'ACTION_REJECTED'
              ? 'Signature declined. Claiming needs a one-time signature to validate your address.'
              : 'Could not get a signature. Try again.',
        })
        return
      }

      setState({ step: 'sending' })
      try {
        const res = await submitRewardClaim({
          wallet: startAccount,
          rewardId: perk.id,
          email: trimmed,
          issued: proof.issued,
          signature: proof.signature,
        })
        if (!areAddressesEqual(accountRef.current, startAccount)) return
        setState({ step: 'done', email: trimmed, alreadyClaimed: res.alreadyClaimed })
        onClaimed()
      } catch (error: unknown) {
        if (!areAddressesEqual(accountRef.current, startAccount)) return
        const message =
          error instanceof AffiliateApiError && error.message
            ? error.message
            : 'Could not record your claim.'
        setState({ step: 'error', message, proof })
      }
    },
    [account, email, onClaimed, perk.id, sign, state.step],
  )

  if (state.step === 'done') {
    return (
      <>
        <p>
          Claim recorded for <strong>{state.email}</strong>.
        </p>
        <styledEl.ClaimNote>
          {state.alreadyClaimed
            ? `You had already claimed this perk; we updated the email ${perk.partner} will send your code to.`
            : `${perk.partner} issues the codes and will send yours to that address. We only use it to contact you about this reward.`}
        </styledEl.ClaimNote>
      </>
    )
  }

  const busy = state.step === 'signing' || state.step === 'sending'

  return (
    <styledEl.ClaimForm onSubmit={onSubmit}>
      <styledEl.ClaimLabel>
        Email for your {perk.partner} code
        <styledEl.ClaimInput
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          maxLength={254}
          placeholder="you@example.com"
          autoComplete="email"
          disabled={busy}
        />
      </styledEl.ClaimLabel>
      <styledEl.ClaimNote>
        We only use your email to contact you about this reward. {perk.partner} needs it to send
        your code. No marketing, no commercial use.
      </styledEl.ClaimNote>
      <styledEl.ClaimActionButton type="submit" disabled={busy}>
        {state.step === 'signing'
          ? 'Confirm in your wallet...'
          : state.step === 'sending'
            ? 'Recording claim...'
            : 'Claim my code'}
      </styledEl.ClaimActionButton>
      <styledEl.ClaimNote>
        {state.step === 'error' ? (
          <>
            {state.message}{' '}
            {state.proof ? (
              <>
                You can also{' '}
                <TextLink href={claimHref(perk, account, email.trim(), state.proof)}>
                  request it by email
                </TextLink>
                . The message carries the same signed proof.
              </>
            ) : null}
          </>
        ) : (
          'A one-time signature validates that you own this address. No transaction, no gas.'
        )}
      </styledEl.ClaimNote>
    </styledEl.ClaimForm>
  )
}
