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

function entry(rank: number, wallet: string, vol: number): LeaderboardEntry {
  return { rank, wallet, tier: 'gold', volume30dUsd: vol, volumeTotalUsd: vol, affiliateCount: 0, referredVolumeUsd: 0 }
}

describe('LeaderboardPage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // The API returns only truncated addresses.
    getLeaderboardMock.mockResolvedValue({
      updatedAt: '2026-06-12T00:00:00Z',
      total: 3,
      entries: [entry(1, '0xaaaa...bbbb', 500_000), entry(2, SELF_SHORT, 150_000), entry(3, '0xcccc...dddd', 50_000)],
    })
  })

  it('renders only truncated addresses, never a full address', async () => {
    useWalletInfoMock.mockReturnValue({ account: undefined, chainId: 1 })

    render(<LeaderboardPage />)

    expect(await screen.findByText(SELF_SHORT)).toBeTruthy()
    expect(screen.queryByText(SELF)).toBeNull()
  })

  it('highlights the connected wallet by matching the truncated address', async () => {
    useWalletInfoMock.mockReturnValue({ account: SELF, chainId: 1 })

    render(<LeaderboardPage />)

    // The pinned "Your rank" section and the in-table "you" tag both rely on
    // matching the connected wallet's truncated form against the API rows.
    expect(await screen.findByText('Your rank')).toBeTruthy()
    expect(screen.getAllByText('you').length).toBeGreaterThanOrEqual(1)
  })

  it('shows the not-in-top hint when the connected wallet is absent', async () => {
    useWalletInfoMock.mockReturnValue({ account: '0xfff0000000000000000000000000000000000fff', chainId: 1 })

    render(<LeaderboardPage />)

    await screen.findByText(SELF_SHORT) // table loaded
    expect(screen.queryByText('Your rank')).toBeNull()
    expect(screen.getByText(/isn.t in the top/i)).toBeTruthy()
  })
})
