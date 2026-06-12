import { render, screen, fireEvent } from '@testing-library/react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { type PartnerDashboard, getPartnerDashboard, useOphisAffiliateSign } from 'modules/affiliate'

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
}))

const useWalletInfoMock = useWalletInfo as jest.Mock
const useOphisAffiliateSignMock = useOphisAffiliateSign as jest.Mock
const getPartnerDashboardMock = getPartnerDashboard as jest.Mock

const ACCOUNT = '0xabc0000000000000000000000000000000000001'

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
    currentCycleVolumeUsd: 0,
    lifetimeReferredVolumeUsd: 5_000_000,
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
})
