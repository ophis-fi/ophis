import { useWalletInfo } from '@cowprotocol/wallet'

import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import {
  type PartnerDashboard,
  type RankStatus,
  AffiliateApiError,
  getPartnerDashboard,
  getRankStatus,
  useOphisAffiliateSign,
} from 'modules/affiliate'

import { PartnerPage } from './Partner.container'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('pages/Affiliate/ConnectWalletCta', () => ({ ConnectWalletCta: 'button' }))
jest.mock('modules/affiliate', () => ({
  ...jest.requireActual('modules/affiliate'),
  useOphisAffiliateSign: jest.fn(),
  getPartnerDashboard: jest.fn(),
  getRankStatus: jest.fn(),
}))

const useWalletInfoMock = useWalletInfo as jest.Mock
const useOphisAffiliateSignMock = useOphisAffiliateSign as jest.Mock
const getPartnerDashboardMock = getPartnerDashboard as jest.Mock
const getRankStatusMock = getRankStatus as jest.Mock

const ACCOUNT = '0xabc0000000000000000000000000000000000001'

const GOLD_RANK: RankStatus = {
  wallet: ACCOUNT.toLowerCase(),
  tier: 'gold',
  volume30dUsd: 150_000,
  rebatePct: 0.25,
  nextTier: 'palladium',
  nextThresholdUsd: 500_000,
  toNextUsd: 350_000,
  position: 5,
}

function makeReferee(i: number): PartnerDashboard['referees'][number] {
  return { wallet: '0x' + String(i).padStart(40, '0'), boundAt: '2026-01-01T00:00:00Z', lifetimeVolumeUsd: 1000 }
}

function makeDashboard(referredCount: number, refereesLen: number): PartnerDashboard {
  return {
    wallet: ACCOUNT,
    kind: 'partner',
    rateOfNetFeePct: 12,
    activeCodes: ['ophispartner'],
    referredCount,
    currentCycleVolumeUsd: 1_000_000,
    lifetimeReferredVolumeUsd: 5_000_000,
    estimatedCurrentCycleEarningsUsd: 90,
    paidToDateWeth: 1.2345,
    paidToDateUsd: 3086,
    nextPayoutAt: '2026-07-01T02:00:00Z',
    referees: Array.from({ length: refereesLen }, (_, i) => makeReferee(i)),
  }
}

async function renderAndLoad(): Promise<void> {
  render(<PartnerPage />)
  fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
  await screen.findByText('Referees')
}

describe('PartnerPage referee-table truncation note', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useWalletInfoMock.mockReturnValue({ account: ACCOUNT, chainId: 1 })
    useOphisAffiliateSignMock.mockReturnValue(
      jest.fn().mockResolvedValue({ wallet: ACCOUNT, issued: 1, signature: '0xsig', chainId: 5042 }),
    )
    getRankStatusMock.mockResolvedValue(GOLD_RANK)
  })

  it('shows the truncation note when more referees exist than the table shows', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(501, 500))

    await renderAndLoad()

    const note = screen.getByText(/most recently referred of/i)
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('Showing the 500')
    expect(note.textContent).toContain('of 501')
  })

  it('explains the approved-chain requirement when contract authentication is unavailable', async () => {
    getPartnerDashboardMock.mockRejectedValue(new AffiliateApiError(401))
    render(<PartnerPage />)
    fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
    expect(await screen.findByText('Signature not verified')).toBeTruthy()
    expect(screen.getByText(/contact Ophis if that chain has not been configured/i)).toBeTruthy()
    expect(screen.queryByText('Signature expired')).toBeNull()
  })

  it('hides the truncation note when every referee is shown', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(screen.queryByText(/No referees yet/i)).toBeNull()
    expect(screen.queryByText(/most recently referred of/i)).toBeNull()
  })

  it('renders the partner referral code, share link, and share actions', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(screen.getByText('ophispartner')).toBeTruthy()
    expect(screen.getByText('https://swap.ophis.fi/?ref=ophispartner')).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy share link/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /share on x/i })).toBeTruthy()
  })

  it('shows the how-it-works steps when there are no referees yet', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(0, 0))

    await renderAndLoad()

    expect(screen.getByText(/how the program works/i)).toBeTruthy()
    expect(screen.getByText(/attributes that trade, not the wallet for life/i)).toBeTruthy()
    expect(screen.queryByText('No referees yet. Share your code to start referring wallets.')).toBeNull()
  })

  it('renders the earnings panel (estimated, paid-to-date, next payout)', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(screen.getByText('Earnings')).toBeTruthy()
    expect(screen.getByText(/Estimated this cycle/i)).toBeTruthy()
    expect(screen.getByText(/Paid to date/i)).toBeTruthy()
    expect(screen.getByText(/Payout status/i)).toBeTruthy()
    expect(screen.getByText('Unconfirmed')).toBeTruthy()
    expect(getPartnerDashboardMock).toHaveBeenCalledWith({
      wallet: ACCOUNT,
      issued: 1,
      signature: '0xsig',
      chainId: 5042,
    })
  })

  it('shows code-only and mixed referrals with first-seen dates and small nonzero volume', async () => {
    const dashboard = makeDashboard(2, 2)
    dashboard.referees = [
      {
        ...makeReferee(1),
        boundAt: null,
        firstSeenAt: '2026-02-03T12:00:00Z',
        attribution: 'code',
        lifetimeVolumeUsd: 0.12,
      },
      {
        ...makeReferee(2),
        firstSeenAt: '2026-01-02T12:00:00Z',
        attribution: 'link-and-code',
        lifetimeVolumeUsd: 0.001,
      },
    ]
    getPartnerDashboardMock.mockResolvedValue(dashboard)
    await renderAndLoad()
    const [, codeRow, mixedRow] = screen.getAllByRole('row')
    if (!codeRow || !mixedRow) throw new Error('referee rows missing')
    expect(within(codeRow).getByText('Code')).toBeTruthy()
    expect(within(codeRow).getByText('Feb 3, 2026')).toBeTruthy()
    expect(within(codeRow).getByText('$0.12')).toBeTruthy()
    expect(within(mixedRow).getByText('Link + code')).toBeTruthy()
    expect(within(mixedRow).getByText('Jan 2, 2026')).toBeTruthy()
    expect(within(mixedRow).getByText('<$0.01')).toBeTruthy()
  })

  it('toggles referred volume between lifetime and the current cycle', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(screen.getByText('$5,000,000')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /this cycle/i }))
    expect(screen.getByText('$1,000,000')).toBeTruthy()
  })

  it('renders the trader-rank chip from the /rank endpoint', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(await screen.findByText(/Trader rank:/i)).toBeTruthy()
  })

  it('clears the trader-rank chip when the account changes and the new fetch fails', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))
    getRankStatusMock.mockImplementation((acct: string) =>
      acct.toLowerCase() === ACCOUNT.toLowerCase()
        ? Promise.resolve(GOLD_RANK)
        : Promise.reject(new AffiliateApiError(500)),
    )
    const { rerender } = render(<PartnerPage />)
    fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
    await screen.findByText('Referees')
    expect(await screen.findByText(/Trader rank: Gold/i)).toBeTruthy()

    useWalletInfoMock.mockReturnValue({ account: '0xdef0000000000000000000000000000000000002', chainId: 1 })
    rerender(<PartnerPage />)
    await waitFor(() => expect(screen.queryByText(/Trader rank:/i)).toBeNull())
    expect(screen.queryByText('Referees')).toBeNull()
    expect(screen.queryByText('ophispartner')).toBeNull()
    expect(screen.getByRole('button', { name: /Access Partner Dashboard/i })).toBeTruthy()
  })

  it('does not restore the previous wallet dashboard after a delayed response', async () => {
    const pending: { resolve?: (data: PartnerDashboard) => void } = {}
    getPartnerDashboardMock.mockReturnValue(
      new Promise<PartnerDashboard>((resolve) => {
        pending.resolve = resolve
      }),
    )
    const { rerender } = render(<PartnerPage />)
    fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
    await waitFor(() => expect(getPartnerDashboardMock).toHaveBeenCalledTimes(1))
    useWalletInfoMock.mockReturnValue({ account: '0xdef0000000000000000000000000000000000002', chainId: 1 })
    rerender(<PartnerPage />)
    await act(async () => {
      pending.resolve?.(makeDashboard(3, 3))
    })
    expect(screen.queryByText('Referees')).toBeNull()
    expect(screen.getByRole('button', { name: /Access Partner Dashboard/i })).toBeTruthy()
  })

  it('clears access on disconnect, but preserves it for a checksum-only account change', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))
    const { rerender } = render(<PartnerPage />)
    fireEvent.click(screen.getByRole('button', { name: /Access Partner Dashboard/i }))
    await screen.findByText('Referees')
    useWalletInfoMock.mockReturnValue({ account: ACCOUNT.replace('abc', 'aBc'), chainId: 1 })
    rerender(<PartnerPage />)
    expect(screen.getByText('Referees')).toBeTruthy()
    useWalletInfoMock.mockReturnValue({ account: undefined, chainId: 1 })
    rerender(<PartnerPage />)
    expect(screen.queryByText('Referees')).toBeNull()
    useWalletInfoMock.mockReturnValue({ account: ACCOUNT, chainId: 1 })
    rerender(<PartnerPage />)
    expect(screen.getByRole('button', { name: /Access Partner Dashboard/i })).toBeTruthy()
  })
})
