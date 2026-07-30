import { useWalletInfo } from '@cowprotocol/wallet'

import { render, screen } from '@testing-library/react'

import { RoutePanel } from './RoutePanel.container'

import { getOphisSolversForChain } from '../../solvers'

jest.mock('@cowprotocol/wallet', () => ({
  ...jest.requireActual('@cowprotocol/wallet'),
  useWalletInfo: jest.fn(),
}))

// The lingui macro compiles <Trans> into the runtime '@lingui/react' Trans, so
// the runtime is what must be mocked (mocking '@lingui/react/macro' does not
// intercept it). Render the source message so assertions read the same copy the
// component declares. Matches modules/trade/pure/NetReceivedRow/NetReceivedRow.test.tsx.
jest.mock('@lingui/react', () => ({
  ...jest.requireActual('@lingui/react'),
  // The macro's useLingui() compiles down to this runtime hook too, so mocking
  // '@lingui/react/macro' does not intercept it either. Return an i18n whose _()
  // echoes the source message, so t`Baseline` renders as "Baseline".
  useLingui: () => ({
    i18n: {
      _: (descriptor: { message?: string; id?: string } | string) =>
        typeof descriptor === 'string' ? descriptor : (descriptor.message ?? descriptor.id ?? ''),
    },
    _: (descriptor: { message?: string; id?: string } | string) =>
      typeof descriptor === 'string' ? descriptor : (descriptor.message ?? descriptor.id ?? ''),
  }),
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

const useWalletInfoMock = useWalletInfo as jest.MockedFunction<typeof useWalletInfo>

const OPTIMISM = 10
const ROBINHOOD = 4663
const ETHEREUM = 1

const onChain = (chainId: number): void => {
  useWalletInfoMock.mockReturnValue({ chainId, account: undefined } as never)
}

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

  it('renders nothing on a CoW-hosted chain, even though the CMS has solvers there', () => {
    // THE BUG THIS GUARDS: gating on the merged useSolversInfo count renders the
    // panel on Ethereum once the CMS hydrates, telling the user "Ophis runs a
    // batch auction" about an order that is posted to api.cow.fi. Ophis runs the
    // auction only where Ophis runs the orderbook, so the gate is the sovereign
    // registry, which has no Ethereum entry.
    onChain(ETHEREUM)
    const { container } = render(<RoutePanel />)

    expect(getOphisSolversForChain(ETHEREUM)).toHaveLength(0)
    expect(container.innerHTML).toBe('')
  })

  it('renders on the sovereign chains', () => {
    for (const chainId of [OPTIMISM, ROBINHOOD]) {
      onChain(chainId)
      const { container, unmount } = render(<RoutePanel />)

      expect(getOphisSolversForChain(chainId).length).toBeGreaterThan(0)
      expect(container.innerHTML).not.toBe('')
      unmount()
    }
  })

  it('never names a competitor', () => {
    onChain(OPTIMISM)
    const { container } = render(<RoutePanel />)
    const rendered = (container.textContent ?? '').toLowerCase()

    expect(rendered).not.toBe('')
    for (const brand of BANNED_BRAND_TOKENS) {
      expect(rendered).not.toContain(brand)
    }
    expect(screen.getAllByText('External solver').length).toBeGreaterThan(0)
    expect(screen.queryByText('Baseline')).not.toBeNull()
  })

  it('states what is CONFIGURED, never that anyone is bidding', () => {
    onChain(OPTIMISM)
    const total = getOphisSolversForChain(OPTIMISM).length
    const { container } = render(<RoutePanel />)
    const rendered = (container.textContent ?? '').toLowerCase()

    // "up to" is load-bearing: the app has no pre-trade bid data at all, so any
    // present-tense claim here would be fabricated.
    expect(rendered).toContain(`up to ${total} solvers`)
    expect(rendered).toContain('can compete')
    expect(rendered).not.toContain('bidding')
    expect(rendered).not.toContain('are competing')
  })

  it('states the guarantee in an order-kind neutral way', () => {
    onChain(OPTIMISM)
    const { container } = render(<RoutePanel />)
    const rendered = container.textContent ?? ''

    // A SELL order signs a minimum BUY amount; a BUY order signs a maximum SELL
    // amount. Saying "the minimum you signed" is false for every buy order, which
    // is what the form produces when the user types an exact output amount.
    expect(rendered).toContain('respect the limit you signed')
    expect(rendered).not.toContain('match the minimum you signed')
    expect(rendered).toContain('surplus')
  })

  it('says a route is chosen only at settlement, not before signing', () => {
    onChain(OPTIMISM)
    const { container } = render(<RoutePanel />)

    expect(container.textContent ?? '').toContain('No route is picked before you sign')
  })

  it('renders one row per registry solver for the chain', () => {
    onChain(ROBINHOOD)
    const expected = getOphisSolversForChain(ROBINHOOD)
    const { container } = render(<RoutePanel />)

    expect(container.querySelectorAll('li')).toHaveLength(expected.length)
  })
})
