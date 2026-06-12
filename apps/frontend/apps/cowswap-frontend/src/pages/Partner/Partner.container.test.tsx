import { render, screen, fireEvent } from '@testing-library/react'

import { useWalletInfo } from '@cowprotocol/wallet'

import {
  type PartnerDashboard,
  type RankStatus,
  getPartnerDashboard,
  getRankStatus,
  useOphisAffiliateSign,
} from 'modules/affiliate'

import { PartnerPage } from './Partner.container'

// PartnerPage reads the connected wallet and issues a signed POST to the
// rebate-indexer. Mock the wallet hook and the affiliate barrel's signed-flow
// seam so the dashboard renders with controlled data; keep the rest of the
// barrel real (AffiliateApiError etc.) via requireActual.
jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
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

// referredCount is the un-capped total; refereesLen is how many rows the capped
// /partner query returned (LIMIT 500). The note shows iff referredCount > refereesLen.
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

// Render, click through the signature gate, and wait for the signed POST to
// resolve and populate the dashboard (the Referees section appears).
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
      jest.fn().mockResolvedValue({ wallet: ACCOUNT, issued: 1, signature: '0xsig' }),
    )
    getRankStatusMock.mockResolvedValue(GOLD_RANK)
  })

  it('shows the truncation note when more referees exist than the table shows', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(501, 500))

    await renderAndLoad()

    // getByText throws if the note is absent, so a returned element is itself
    // the proof it rendered. The text is interpolated across JSX nodes, so match
    // the static substring, then assert the interpolated counts via textContent.
    const note = screen.getByText(/most recently bound of/i)
    expect(note).toBeTruthy()
    expect(note.textContent).toContain('Showing the 500')
    expect(note.textContent).toContain('of 501')
  })

  it('hides the truncation note when every referee is shown', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    // The table renders (not the empty state) but the note must be absent.
    expect(screen.queryByText(/No referees yet/i)).toBeNull()
    expect(screen.queryByText(/most recently bound of/i)).toBeNull()
  })

  it('renders the partner referral code, share link, and share actions', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    // activeCodes[0] is 'ophispartner' in the fixture; it was previously absent
    // from this page, so a partner could not get their link here.
    expect(screen.getByText('ophispartner')).toBeTruthy()
    expect(screen.getByText('https://swap.ophis.fi/?ref=ophispartner')).toBeTruthy()
    expect(screen.getByRole('button', { name: /copy share link/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /share on x/i })).toBeTruthy()
  })

  it('shows the how-it-works steps when there are no referees yet', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(0, 0))

    await renderAndLoad()

    expect(screen.getByText(/how the program works/i)).toBeTruthy()
    // the bare one-liner is replaced by the 3-step guide
    expect(
      screen.queryByText('No referees yet. Share your code to start referring wallets.'),
    ).toBeNull()
  })

  it('renders the earnings panel (estimated, paid-to-date, next payout)', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(screen.getByText('Earnings')).toBeTruthy()
    expect(screen.getByText(/Estimated this cycle/i)).toBeTruthy()
    expect(screen.getByText(/Paid to date/i)).toBeTruthy()
    expect(screen.getByText(/Next payout/i)).toBeTruthy()
  })

  it('toggles referred volume between lifetime and the current cycle', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    // Defaults to lifetime ($5,000,000).
    expect(screen.getByText('$5,000,000')).toBeTruthy()
    // Switching to the current cycle shows currentCycleVolumeUsd ($1,000,000).
    fireEvent.click(screen.getByRole('button', { name: /this cycle/i }))
    expect(screen.getByText('$1,000,000')).toBeTruthy()
  })

  it('renders the trader-rank chip from the /rank endpoint', async () => {
    getPartnerDashboardMock.mockResolvedValue(makeDashboard(3, 3))

    await renderAndLoad()

    expect(await screen.findByText(/Trader rank:/i)).toBeTruthy()
  })
})
