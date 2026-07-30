import { render, screen } from '@testing-library/react'

import { useSolversInfo } from 'common/hooks/useSolversInfo'

import { RoutePanel } from './RoutePanel'

import { OPHIS_SOLVERS } from '../../solvers'

jest.mock('@cowprotocol/wallet', () => ({
  ...jest.requireActual('@cowprotocol/wallet'),
  useWalletInfo: jest.fn(() => ({ chainId: 10, account: undefined })),
}))

jest.mock('common/hooks/useSolversInfo', () => ({
  useSolversInfo: jest.fn(),
}))

// The lingui macro compiles <Trans> into the runtime '@lingui/react' Trans, so
// the runtime is what must be mocked (mocking '@lingui/react/macro' does not
// intercept it). Render the source message so assertions read the same copy the
// component declares. Matches modules/trade/pure/NetReceivedRow/NetReceivedRow.test.tsx.
jest.mock('@lingui/react', () => ({
  ...jest.requireActual('@lingui/react'),
  Trans: ({ message, id, values }: { message?: string; id?: string; values?: Record<string, unknown> }) => {
    const source = message ?? id ?? ''
    // Interpolate {total} the way lingui would, so the count assertions are real.
    const text = Object.entries(values ?? {}).reduce(
      (acc, [key, value]) => acc.split(`{${key}}`).join(String(value)),
      source,
    )
    return <>{text}</>
  },
}))

const useSolversInfoMock = useSolversInfo as jest.MockedFunction<typeof useSolversInfo>

// Shape only matters in that Object.keys() gives the solver ids.
const solversFor = (ids: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(ids.map((id) => [id, { solverId: id, displayName: 'CMS NAME', description: 'CMS DESC' }]))

/**
 * Every third-party brand that must never reach rendered copy. Mirrors
 * BANNED_BRAND_TOKENS in ophis/solvers.test.ts; kept as its own list here so the
 * panel is pinned even if that file is refactored.
 */
const BANNED_BRAND_TOKENS = [
  'odos',
  'kyberswap',
  'kyber',
  'okx',
  'velora',
  'paraswap',
  'enso',
  'lifi',
  'li.fi',
  'openocean',
  'dodo',
  '1inch',
]

describe('RoutePanel', () => {
  beforeEach(() => jest.clearAllMocks())

  it('renders nothing when the chain has no known solvers', () => {
    useSolversInfoMock.mockReturnValue(solversFor([]) as never)
    const { container } = render(<RoutePanel />)

    // Not an empty shell: a chain with no solvers gets no panel at all.
    // (jest-dom matchers are not set up in this app, so assert on the DOM directly.)
    expect(container.innerHTML).toBe('')
  })

  it('never names a competitor, even when the CMS supplies a brand name', () => {
    // The CMS displayName is deliberately a brand string here. The panel must
    // ignore it and go through ophisSolverPublicLabel.
    useSolversInfoMock.mockReturnValue(
      Object.fromEntries(
        ['baseline', 'kyberswap', 'okx', 'velora', 'enso', 'lifi', 'openocean', 'dodo'].map((id) => [
          id,
          { solverId: id, displayName: `${id.toUpperCase()} Aggregator`, description: `Routes through ${id}` },
        ]),
      ) as never,
    )
    const { container } = render(<RoutePanel />)
    const rendered = (container.textContent ?? '').toLowerCase()

    expect(rendered).not.toBe('')
    for (const brand of BANNED_BRAND_TOKENS) {
      expect(rendered).not.toContain(brand)
    }
    // The neutral alias is what shows instead.
    expect(screen.getAllByText('External solver').length).toBeGreaterThan(0)
    expect(screen.queryByText('Baseline')).not.toBeNull()
  })

  it('states what is CONFIGURED, never that anyone is bidding', () => {
    useSolversInfoMock.mockReturnValue(solversFor(['baseline', 'kyberswap', 'lifi']) as never)
    const { container } = render(<RoutePanel />)
    const rendered = (container.textContent ?? '').toLowerCase()

    // "up to" is load-bearing: listing a solver in the driver config does not
    // guarantee it bids on any given auction, and the app has no pre-trade bid
    // data at all. Any present-tense claim here would be fabricated.
    expect(rendered).toContain('up to 3 solvers')
    expect(rendered).toContain('can compete')
    expect(rendered).not.toContain('bidding')
    expect(rendered).not.toContain('are competing')
    expect(rendered).not.toContain('solvers competing')
  })

  it('says a route is chosen only at settlement, not before signing', () => {
    useSolversInfoMock.mockReturnValue(solversFor(['baseline', 'lifi']) as never)
    const { container } = render(<RoutePanel />)
    const rendered = container.textContent ?? ''

    // The whole point of the panel: for an intent protocol there IS no pre-trade
    // route. If this assertion is ever relaxed, the panel has started lying.
    expect(rendered).toContain('No route is picked before you sign')
    expect(rendered).toContain('surplus')
  })

  it('uses the singular form for a one-solver chain', () => {
    useSolversInfoMock.mockReturnValue(solversFor(['baseline']) as never)
    const { container } = render(<RoutePanel />)
    const rendered = (container.textContent ?? '').toLowerCase()

    expect(rendered).toContain('1 solver')
    expect(rendered).not.toContain('up to 1 solvers')
  })

  it('agrees with the static registry on the chain-10 count', () => {
    // Pins the panel to the same source RowSolverCompetition reads, so the rail
    // and the fee accordion can never show different numbers.
    const OPTIMISM = 10
    const chainTen = OPHIS_SOLVERS.filter((s) => s.chainIds.includes(OPTIMISM))
    useSolversInfoMock.mockReturnValue(solversFor(chainTen.map((s) => s.solverId)) as never)
    const { container } = render(<RoutePanel />)

    expect(container.textContent).toContain(`up to ${chainTen.length} solvers`)
  })
})
