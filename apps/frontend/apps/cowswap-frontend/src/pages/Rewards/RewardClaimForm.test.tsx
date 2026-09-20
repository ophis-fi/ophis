import { fireEvent, render, screen, waitFor } from '@testing-library/react'

import { submitRewardClaim, useOphisAffiliateSign } from 'modules/affiliate'

import { RewardClaimForm } from './RewardClaimForm'
import { REWARDS_PERKS } from './rewards.const'

jest.mock('modules/affiliate', () => ({
  AffiliateApiError: class extends Error {},
  submitRewardClaim: jest.fn(),
  useOphisAffiliateSign: jest.fn(),
}))
jest.mock('ophis/ds', () => ({ TextLink: 'a' }))
jest.mock('./Rewards.styled', () => ({
  ClaimForm: 'form',
  ClaimLabel: 'label',
  ClaimInput: 'input',
  ClaimNote: 'span',
  ClaimActionButton: 'button',
}))

const wallet = '0x1111111111111111111111111111111111111111'
const proof = { wallet, issued: 1_800_000_000, signature: '0xsigned-email' }
const perk = REWARDS_PERKS[0]

it('signs the exact trimmed delivery email before submitting a reward claim', async () => {
  const sign = jest.fn().mockResolvedValue(proof)
  jest.mocked(useOphisAffiliateSign).mockReturnValue(sign)
  jest
    .mocked(submitRewardClaim)
    .mockResolvedValue({ claimed: true, rewardId: perk.id, xp: 50000, alreadyClaimed: false })
  render(<RewardClaimForm perk={perk} wallet={wallet} />)
  expect(sign).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: ' Person@example.com ' } })
  const form = screen.getByRole('button').closest('form')
  if (!form) throw new Error('claim form missing')
  fireEvent.submit(form)
  await waitFor(() =>
    expect(submitRewardClaim).toHaveBeenCalledWith({
      ...proof,
      rewardId: perk.id,
      email: 'Person@example.com',
    }),
  )
  expect(sign).toHaveBeenCalledWith(`claim reward ${perk.id}\nEmail: Person@example.com`)
})

it('never submits a claim when the wallet declines the email signature', async () => {
  jest.mocked(submitRewardClaim).mockClear()
  jest.mocked(useOphisAffiliateSign).mockReturnValue(jest.fn().mockRejectedValue(new Error('User rejected')))
  render(<RewardClaimForm perk={perk} wallet={wallet} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'person@example.com' } })
  const form = screen.getByRole('button').closest('form')
  if (!form) throw new Error('claim form missing')
  fireEvent.submit(form)
  await screen.findByText(/Could not record your claim/)
  expect(submitRewardClaim).not.toHaveBeenCalled()
})
