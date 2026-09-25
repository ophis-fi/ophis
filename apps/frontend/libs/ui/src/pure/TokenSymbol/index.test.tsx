import { ARC_CIRBTC, ARC_EURC, ARC_USDC, USDCE_INK, USDC_MAINNET } from '@cowprotocol/common-const'

import { i18n } from '@lingui/core'
import { render, screen } from '@testing-library/react'

import { TokenSymbol } from './index'

const badge = /Circle-issued token: contract address matches Circle's official records/

beforeAll(() => {
  i18n.load('en', {})
  i18n.activate('en')
})

it.each([ARC_USDC, ARC_EURC, ARC_CIRBTC, USDC_MAINNET])(
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
