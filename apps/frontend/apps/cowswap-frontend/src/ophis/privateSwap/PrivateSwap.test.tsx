import { act, render, screen } from '@testing-library/react'

import { PrivateSwap } from './PrivateSwap.container'
import * as privateSwapSession from './privateSwapSession.utils'

jest.mock('ophis/hooks/useIsMobileSwap', () => ({ useIsMobileSwap: () => false }))
jest.mock('ophis/mobile/MobileSwapHeading.pure', () => ({ MobileSwapHeading: () => null }))
jest.mock('./privateSwapSession.utils', () => ({
  __esModule: true,
  ...jest.requireActual<typeof import('./privateSwapSession.utils')>('./privateSwapSession.utils'),
  PRIVATE_SWAP_DOCUMENT: true,
}))

const valid = { type: 'ophis:private-layout-v1', height: 900, busy: false, chainId: 56 }

function receive(data: unknown, overrides: MessageEventInit = {}): void {
  const frame = screen.getByTitle<HTMLIFrameElement>('Ophis private swap wallet')
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data,
        ...overrides,
      }),
    )
  })
}

beforeEach(() => {
  window.history.replaceState({}, '', '/private-swap/')
})

afterEach(() => jest.restoreAllMocks())

it('accepts its own frame state, persists the chain and gates navigation until idle', () => {
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
  const frame = screen.getByTitle('Ophis private swap wallet')
  const publicButton = screen.getByRole('button', { name: 'Public' })
  receive({ ...valid, busy: true })
  expect(frame.getAttribute('height')).toBe('900')
  expect(publicButton.hasAttribute('disabled')).toBe(true)
  expect(window.location.search).toBe('?privateChain=56')
  expect(frame.getAttribute('src')).toBe('/private/?chainId=1')
  receive({ ...valid, busy: false })
  expect(publicButton.hasAttribute('disabled')).toBe(false)
})

it.each([{ origin: 'https://untrusted.example' }, { source: window }, { source: null }])(
  'rejects messages from an untrusted origin or window: %j',
  (overrides) => {
    render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
    receive({ ...valid, busy: true })
    receive({ ...valid, height: 1200, busy: false }, overrides)
    expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe('900')
    expect(screen.getByRole('button', { name: 'Public' }).hasAttribute('disabled')).toBe(true)
    expect(window.location.search).toBe('?privateChain=56')
  },
)

it.each([
  null,
  {},
  'invalid',
  { ...valid, type: 'other' },
  { ...valid, height: NaN },
  { ...valid, height: Infinity },
  { ...valid, height: '900' },
  { ...valid, busy: 1 },
  { ...valid, chainId: 10 },
  { ...valid, chainId: 137 },
  { ...valid, chainId: 8453 },
  { ...valid, chainId: '56' },
])('rejects malformed layout data: %j', (data) => {
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
  receive(data)
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe('520')
  expect(screen.queryByText('0.1% Ophis fee')).toBeNull()
  expect(window.location.search).toBe('')
})

it.each([
  [1, '240'],
  [99999, '6000'],
])('clamps height %s to %s', (height, expected) => {
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
  receive({ ...valid, height })
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe(expected)
})

it.each([1, 56, 42161])('opens the requested supported private network %s', (chainId) => {
  window.history.replaceState({}, '', `/private-swap/?privateChain=${chainId}`)
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('src')).toBe(`/private/?chainId=${chainId}`)
  expect(screen.queryByRole('region', { name: 'Private network unavailable' })).toBeNull()
})

it.each([1, 56, 42161])('accepts layout messages for supported private network %s', (chainId) => {
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
  receive({ ...valid, chainId })
  expect(window.location.search).toBe(`?privateChain=${chainId}`)
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe('900')
})

it.each(['137', '8453', '10', 'invalid', '', '0', '1e0', '01', '1&privateChain=137'])(
  'requires explicit supported-network navigation for privateChain=%s without opening a wallet',
  (requested) => {
    const route = `/private-swap/?privateChain=${requested}&tab=recovery#/56/swap/_/_`
    window.history.replaceState({}, '', route)
    render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
    expect(screen.queryByTitle('Ophis private swap wallet')).toBeNull()
    expect(screen.getByRole('region', { name: 'Private network unavailable' })).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Supported private networks' })).toBeTruthy()
    const links = screen.getAllByRole<HTMLAnchorElement>('link')
    expect(links.map((link) => new URL(link.href).searchParams.get('privateChain'))).toEqual(['1', '56', '42161'])
    for (const link of links) {
      expect(link.textContent).toBeTruthy()
      const url = new URL(link.href)
      expect(url.pathname).toBe('/private-swap/')
      expect(url.searchParams.getAll('privateChain')).toHaveLength(1)
      expect(url.searchParams.get('tab')).toBe('recovery')
      expect(url.hash).toBe('#/56/swap/_/_')
    }
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(route)
    expect(screen.getByRole('button', { name: 'Public' }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: 'Private' }).getAttribute('aria-pressed')).toBe('true')
    expect(new URL(privateSwapSession.privateSwapUrl(false)).pathname).toBe('/')
  },
)

it.each([137, 8453])('keeps the ordinary public swap available with disabled privateChain=%s', (chainId) => {
  jest.replaceProperty(privateSwapSession, 'PRIVATE_SWAP_DOCUMENT', false)
  window.history.replaceState({}, '', `/?privateChain=${chainId}#/137/swap/_/_`)
  render(<PrivateSwap publicSwap={<button type="button">Connect public swap wallet</button>} />)
  expect(screen.getByRole('button', { name: 'Connect public swap wallet' }).hasAttribute('disabled')).toBe(false)
  expect(screen.queryByTitle('Ophis private swap wallet')).toBeNull()
  expect(screen.queryByRole('region', { name: 'Private network unavailable' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Public' }).getAttribute('aria-pressed')).toBe('true')
  const privateUrl = new URL(privateSwapSession.privateSwapUrl(true))
  expect(privateUrl.pathname).toBe('/private-swap/')
  expect(privateUrl.searchParams.get('privateChain')).toBe(String(chainId))
  expect(privateUrl.hash).toBe('#/137/swap/_/_')
})
