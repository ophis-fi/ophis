import { useCopyClipboard } from '@cowprotocol/common-hooks'

import { fireEvent, render, screen } from '@testing-library/react'

import { OphisAffiliateDashboard } from './OphisAffiliateDashboard'

import { useOphisAffiliateSign } from '../hooks/useOphisAffiliateSign'
import { AffiliateApiError, createRefCode, getAffiliateStats } from '../lib/ophisAffiliateApi'

jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useCopyClipboard: jest.fn(),
}))
jest.mock('../hooks/useOphisAffiliateSign', () => ({ useOphisAffiliateSign: jest.fn() }))
jest.mock('../lib/ophisAffiliateApi', () => ({
  ...jest.requireActual('../lib/ophisAffiliateApi'),
  createRefCode: jest.fn(),
  getAffiliateStats: jest.fn(),
}))

const ACCOUNT = '0xabc0000000000000000000000000000000000001'
const signedBody = { wallet: ACCOUNT, issued: 1, signature: '0xsig' }
const sign = jest.fn()
const copy = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useCopyClipboard).mockReturnValue([false, copy])
  jest.mocked(useOphisAffiliateSign).mockReturnValue(sign)
  sign.mockResolvedValue(signedBody)
})

it.each(['regular', 'partner'] as const)('keeps %s attribution and sharing without fee shares', async (kind) => {
  jest.mocked(getAffiliateStats).mockResolvedValue({
    wallet: ACCOUNT,
    kind,
    activeCodes: ['mycode'],
    referredCount: 3,
    currentCycleVolumeUsd: 10_000,
    lifetimeReferredVolumeUsd: kind === 'partner' ? 125_000 : 0,
  })

  render(<OphisAffiliateDashboard account={ACCOUNT} />)

  expect(await screen.findByText('mycode')).toBeTruthy()
  expect(screen.getByText(kind === 'partner' ? '$125,000' : '$10,000')).toBeTruthy()
  expect(screen.getByText(kind === 'partner' ? 'lifetime' : 'this month')).toBeTruthy()
  expect(screen.getByText('Referred wallets')).toBeTruthy()
  expect(screen.queryByText(/earn|payout|rebate|your rate|tier|WETH/i)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }))
  expect(copy).toHaveBeenCalledWith('https://swap.ophis.fi/?ref=mycode')
  expect(screen.queryByRole('button', { name: 'Create your referral code' })).toBeNull()
  if (kind === 'partner') {
    expect(screen.getByRole('link', { name: 'View your full partner dashboard' }).getAttribute('href')).toBe(
      '/#/partner',
    )
  }
})

it('creates a referral code with the existing signature flow and exposes its share link', async () => {
  jest.mocked(getAffiliateStats).mockRejectedValue(new AffiliateApiError(404))
  jest.mocked(createRefCode).mockResolvedValue({ code: 'newcode', kind: 'regular', created: true })

  render(<OphisAffiliateDashboard account={ACCOUNT} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Create your referral code' }))

  expect(await screen.findByText('https://swap.ophis.fi/?ref=newcode')).toBeTruthy()
  expect(sign).toHaveBeenCalledWith('create referral code')
  expect(createRefCode).toHaveBeenCalledWith(signedBody)
  expect(screen.queryByText(/earn|payout|rebate|your rate|tier|WETH/i)).toBeNull()
})

it('keeps creation unavailable when referral status cannot be loaded', async () => {
  jest.mocked(getAffiliateStats).mockRejectedValue(new AffiliateApiError(500))

  render(<OphisAffiliateDashboard account={ACCOUNT} />)

  expect(await screen.findByText('Could not load your status')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create your referral code' })).toBeNull()
  expect(createRefCode).not.toHaveBeenCalled()
})
