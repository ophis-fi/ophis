import { ARC_CIRBTC, ARC_EURC, ARC_USDC, ARC_USYC, USDCE_INK, USDC_MAINNET } from '@cowprotocol/common-const'

import { i18n } from '@lingui/core'
import { act, fireEvent, render, screen } from '@testing-library/react'

import { TokenSymbol } from './index'

const badge = /Official Circle token/

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: jest.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    })),
  })
  i18n.load('en', {})
  i18n.activate('en')
})

it.each([ARC_USDC, ARC_EURC, ARC_CIRBTC, ARC_USYC, USDC_MAINNET])(
  'marks the issuer contract for $symbol on $chainId',
  (token) => {
    render(<TokenSymbol token={token} />)
    expect(screen.getByRole('img', { name: badge })).toBeTruthy()
  },
)

it.each([
  { ...ARC_CIRBTC, address: '0x1111111111111111111111111111111111111111' },
  { ...ARC_CIRBTC, chainId: 1 },
  { ...ARC_CIRBTC, decimals: 18 },
  { ...ARC_USDC, symbol: 'EURC' },
  { ...ARC_USDC, address: 'invalid' },
  { symbol: 'USDC', name: 'Circle verified' },
  USDCE_INK,
])('does not authenticate copied metadata, wrong networks, or bridged wrappers %#', (token) => {
  render(<TokenSymbol token={token} />)
  expect(screen.queryByRole('img', { name: badge })).toBeNull()
})

it('matches the same contract regardless of address letter case', () => {
  render(<TokenSymbol token={{ ...ARC_CIRBTC, address: '0x171a4217b86a807a64eb94757db6849fb4bdbaa0' }} />)
  expect(screen.getByRole('img', { name: badge })).toBeTruthy()
})

it('shows the issuer explanation on hover and includes USYC eligibility', async () => {
  render(<TokenSymbol token={ARC_USYC} />)
  const icon = screen.getByRole('img', { name: badge })
  expect(screen.queryByRole('tooltip')).toBeNull()
  await act(async () => {
    fireEvent.mouseEnter(icon)
  })
  expect(screen.getByRole('tooltip').textContent).toContain('USYC requires an eligible, allowlisted wallet')
  await act(async () => {
    fireEvent.mouseLeave(icon)
  })
  expect(screen.queryByRole('tooltip')).toBeNull()
})
