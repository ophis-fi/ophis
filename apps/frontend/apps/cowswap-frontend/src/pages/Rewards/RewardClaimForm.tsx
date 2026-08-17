/**
 * RewardClaimForm: email capture for partner-fulfilled perks.
 *
 * Rendered only AFTER the address validation in RewardCard succeeds, so the
 * signature that proves wallet ownership already exists and is reused as the
 * claim's auth (no second wallet prompt).
 *
 * The email is collected for one purpose only: contacting the claimer about
 * this reward, i.e. the partner sending the code. The form says so.
 *
 * Why it exists: perks like Octav have no in-app code. The partner issues the
 * codes, which means Ophis has to hand them a list of who claimed. The previous
 * flow ended at a `mailto:` link, so a claim only existed if the visitor
 * actually sent the pre-filled mail; there was no claim list at all. This posts
 * the claim to the rebate indexer (POST /rewards/claim), which re-checks
 * eligibility server-side and records (address, email) for the hand-off.
 *
 * The mailto stays as the FALLBACK for a failed POST: a claimer whose request
 * is blocked (offline, CORS, indexer down) can still reach a human, so a
 * backend outage never strands an eligible reward.
 */
import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import { TextLink } from 'ophis/ds'

import { AffiliateApiError, submitRewardClaim } from 'modules/affiliate'

import { CLAIM_EMAIL, RewardPerk } from './rewards.const'
import * as styledEl from './Rewards.styled'

type SubmitState =
  | { step: 'idle' }
  | { step: 'sending' }
  | { step: 'done'; email: string; alreadyClaimed: boolean }
  | { step: 'error'; message: string }

interface RewardClaimFormProps {
  perk: RewardPerk
  /** The address that produced `signature` (already validated by RewardCard). */
  wallet: string
  issued: number
  signature: string
}

/** Pre-filled fallback mail, carrying the same signed proof the POST would have. */
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

// The signature is valid for 5 minutes server-side (PARTNER_SIG_MAX_AGE_SEC), so
// a form left open past that window gets a 401 on submit. Say so plainly instead
// of surfacing the raw backend reason.
const EXPIRED_MESSAGE = 'This claim expired. Close and click "Claim reward" again to re-validate.'

export function RewardClaimForm({ perk, wallet, issued, signature }: RewardClaimFormProps): ReactNode {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<SubmitState>({ step: 'idle' })

  const onSubmit = useCallback(
    async (event: Event): Promise<void> => {
      event.preventDefault()
      if (state.step === 'sending') return
      setState({ step: 'sending' })
      try {
        const res = await submitRewardClaim({
          wallet,
          rewardId: perk.id,
          email: email.trim(),
          issued,
          signature,
        })
        setState({ step: 'done', email: email.trim(), alreadyClaimed: res.alreadyClaimed })
      } catch (error: unknown) {
        const status = error instanceof AffiliateApiError ? error.status : undefined
        const message =
          status === 401
            ? EXPIRED_MESSAGE
            : error instanceof AffiliateApiError && error.message
              ? error.message
              : 'Could not record your claim.'
        setState({ step: 'error', message })
      }
    },
    [email, issued, perk.id, signature, state.step, wallet],
  )

  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    const form = formRef.current
    if (!form) return
    const listener = (event: Event): void => void onSubmit(event)
    form.addEventListener('submit', listener)
    return () => form.removeEventListener('submit', listener)
  }, [onSubmit])

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

  return (
    <styledEl.ClaimForm ref={formRef}>
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
          disabled={state.step === 'sending'}
        />
      </styledEl.ClaimLabel>
      <styledEl.ClaimNote>
        We only use your email to contact you about this reward. {perk.partner} needs it to send your code. No
        marketing, no commercial use.
      </styledEl.ClaimNote>
      <styledEl.ClaimActionButton type="submit" disabled={state.step === 'sending'}>
        {state.step === 'sending' ? 'Recording claim...' : 'Claim my code'}
      </styledEl.ClaimActionButton>
      {state.step === 'error' && (
        <styledEl.ClaimNote>
          {state.message}{' '}
          {state.message === EXPIRED_MESSAGE ? null : (
            <>
              You can also <TextLink href={claimHref(perk, wallet, issued, signature)}>request it by email</TextLink>.
              The message carries the same signed proof.
            </>
          )}
        </styledEl.ClaimNote>
      )}
    </styledEl.ClaimForm>
  )
}
