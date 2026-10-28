import { act, render, screen } from '@testing-library/react'

import { PrivateSwap } from './PrivateSwap.container'

jest.mock('ophis/hooks/useIsMobileSwap', () => ({ useIsMobileSwap: () => false }))
jest.mock('ophis/mobile/MobileSwapHeading.pure', () => ({ MobileSwapHeading: () => null }))
jest.mock('./privateSwapSession.utils', () => ({ PRIVATE_SWAP_DOCUMENT: true, privateSwapUrl: jest.fn() }))

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
  render(<PrivateSwap publicSwap={<span>Public swap</span>} />)
})

it('accepts its own frame state, persists the chain and gates navigation until idle', () => {
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
  { ...valid, chainId: '56' },
])('rejects malformed layout data: %j', (data) => {
  receive(data)
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe('740')
  expect(window.location.search).toBe('')
})

it.each([
  [1, '240'],
  [99999, '6000'],
])('clamps height %s to %s', (height, expected) => {
  receive({ ...valid, height })
  expect(screen.getByTitle('Ophis private swap wallet').getAttribute('height')).toBe(expected)
})
