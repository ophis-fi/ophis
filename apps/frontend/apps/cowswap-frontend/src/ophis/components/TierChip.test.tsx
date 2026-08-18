import { render, screen } from '@testing-library/react'

import { TierChip } from './TierChip'

import { useTier } from '../hooks/useTier'

jest.mock('../hooks/useTier', () => ({
  useTier: jest.fn(),
}))

const mockUseTier = useTier as jest.MockedFunction<typeof useTier>
const WALLET = '0x0000000000000000000000000000000000000001' as const

describe('TierChip', () => {
  it('shows only the current rank for an opted-in wallet', () => {
    mockUseTier.mockReturnValue({
      data: {
        wallet: WALLET,
        volume_30d_usd: 12_345,
        trade_count_30d: 4,
        tier: { name: 'none', min_usd: 0, rebate_pct: 0 },
        next_tier: { name: 'bronze', min_usd: 20_000, rebate_pct: 0.1 },
        usd_to_next_tier: 7_655,
      },
      loading: false,
      error: null,
      optedIn: true,
    })

    render(<TierChip wallet={WALLET} />)

    expect(screen.getByRole('link', { name: 'View unranked rebate rank' }).textContent).toBe('unranked')
    expect(screen.queryByText(/30d:/u)).toBeNull()
    expect(screen.queryByText(/to bronze/u)).toBeNull()
  })
})
