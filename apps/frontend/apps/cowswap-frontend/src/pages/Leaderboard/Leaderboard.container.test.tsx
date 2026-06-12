import { render, screen } from '@testing-library/react'

import { useWalletInfo } from '@cowprotocol/wallet'

import { type LeaderboardEntry, getLeaderboard } from 'modules/affiliate'

import { LeaderboardPage } from './Leaderboard.container'

jest.mock('@cowprotocol/wallet', () => ({ useWalletInfo: jest.fn() }))
jest.mock('modules/affiliate', () => ({
  ...jest.requireActual('modules/affiliate'),
  getLeaderboard: jest.fn(),
}))

const useWalletInfoMock = useWalletInfo as jest.Mock
const getLeaderboardMock = getLeaderboard as jest.Mock

// The connected wallet (full) and the TRUNCATED form the API returns for it.
const SELF = '0x0494f503912c101bfd76b88e4f5d8a33de284d1a'
const SELF_SHORT = '0x0494...4d1a'

function entry(rank: number, wallet: string, vol: number, isSelf = false): LeaderboardEntry {
  return {
    rank,
    wallet,
    tier: 'gold',
    volume30dUsd: vol,
    volumeTotalUsd: vol,
    affiliateCount: 0,
    referredVolumeUsd: 0,
    isSelf,
  }
}

describe('LeaderboardPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Mirror the backend contract: the API returns truncated addresses, and it
    // marks `isSelf` on the caller's own row (full-address match) ONLY when the
    // request carries `self` (i.e. a wallet is connected).
    getLeaderboardMock.mockImplementation((_limit: number, self?: string) => {
      const mine = !!self && self.toLowerCase() === SELF.toLowerCase()
      return Promise.resolve({
        updatedAt: '2026-06-12T00:00:00Z',
        total: 3,
        entries: [
          entry(1, '0xaaaa...bbbb', 500_000),
          entry(2, SELF_SHORT, 150_000, mine),
          entry(3, '0xcccc...dddd', 50_000),
        ],
      })
    })
  })

  it('renders only truncated addresses, never a full address', async () => {
    useWalletInfoMock.mockReturnValue({ account: undefined, chainId: 1 })

    render(<LeaderboardPage />)

    expect(await screen.findByText(SELF_SHORT)).toBeTruthy()
    expect(screen.queryByText(SELF)).toBeNull()
  })

  it('highlights the connected wallet by the backend isSelf flag', async () => {
    useWalletInfoMock.mockReturnValue({ account: SELF, chainId: 1 })

    render(<LeaderboardPage />)

    // The pinned "Your rank" section and the in-table "you" tag both key off the
    // backend's collision-free isSelf flag, NOT the truncated wallet string.
    expect(await screen.findByText('Your rank')).toBeTruthy()
    expect(screen.getAllByText('you').length).toBeGreaterThanOrEqual(1)
  })

  it('does NOT highlight a colliding row that the backend did not mark isSelf', async () => {
    // A different wallet shares SELF's truncated display form, but the backend
    // marks isSelf by full address, so this row is NOT the caller's. The OLD
    // string match (entry.wallet === truncate(account)) would mislabel it "you".
    getLeaderboardMock.mockResolvedValue({
      updatedAt: '2026-06-12T00:00:00Z',
      total: 2,
      entries: [entry(1, SELF_SHORT, 500_000 /* isSelf:false */), entry(2, '0xcccc...dddd', 50_000)],
    })
    useWalletInfoMock.mockReturnValue({ account: SELF, chainId: 1 })

    render(<LeaderboardPage />)

    await screen.findByText(SELF_SHORT)
    expect(screen.queryByText('you')).toBeNull()
    expect(screen.queryByText('Your rank')).toBeNull()
    expect(screen.getByText(/isn.t in the top/i)).toBeTruthy()
  })

  it('shows the not-in-top hint when the connected wallet is absent', async () => {
    useWalletInfoMock.mockReturnValue({ account: '0xfff0000000000000000000000000000000000fff', chainId: 1 })

    render(<LeaderboardPage />)

    await screen.findByText(SELF_SHORT) // table loaded
    expect(screen.queryByText('Your rank')).toBeNull()
    expect(screen.getByText(/isn.t in the top/i)).toBeTruthy()
  })
})
