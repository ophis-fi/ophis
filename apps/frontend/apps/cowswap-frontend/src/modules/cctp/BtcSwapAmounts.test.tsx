import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { render, screen } from '@testing-library/react'

import { useUsdAmount } from 'modules/usdAmount'

import { BtcSwapAmounts } from './BtcSwapAmounts.container'
import { type BtcSwapQuote } from './btcSwapQuote.service'

jest.mock('@cowprotocol/common-hooks', () => ({
  ...jest.requireActual('@cowprotocol/common-hooks'),
  useMediaQuery: () => false,
}))
jest.mock('modules/usdAmount', () => ({ useUsdAmount: jest.fn() }))
jest.mock('modules/bridge', () => ({
  TokenAmountDisplay: jest.requireActual('../bridge/pure/TokenAmountDisplay').TokenAmountDisplay,
}))
jest.mock('@cowprotocol/tokens', () => ({ TokenLogo: () => null }))
const usd = new Token(1, '0x0000000000000000000000000000000000000001', 6, 'USD')
const quote = {
  swap: { orderToSign: { sellAmount: '1000000', buyAmount: '993939' } },
  bridge: { expanded: { feeTotalAmount: '7145237173721' } },
} as BtcSwapQuote

it('uses eight-decimal BTC and eighteen-decimal ETH amounts with available fiat values', () => {
  jest.mocked(useUsdAmount).mockImplementation((amount) => ({
    value: CurrencyAmount.fromRawAmount(usd, amount?.currency.symbol === 'ETH' ? '20000' : '600000000'),
    isLoading: false,
  }))
  const { container } = render(<BtcSwapAmounts quote={quote} />)
  const amounts = jest.mocked(useUsdAmount).mock.calls.map(([amount]) => amount)
  expect(amounts.map((amount) => [amount?.currency.chainId, amount?.toExact()])).toEqual([
    [1, '0.01'],
    [5042, '0.00993939'],
    [1, '0.000007145237173721'],
  ])
  expect(screen.getByText('Minimum received on Arc')).toBeTruthy()
  expect(container.querySelectorAll('.fiat-amount')).toHaveLength(3)
  expect(container.textContent).toContain('$600')
  expect(container.textContent).toContain('$0.02')
})

it('does not fabricate fiat values when the price is unavailable', () => {
  jest.mocked(useUsdAmount).mockReturnValue({ value: null, isLoading: false })
  const { container } = render(<BtcSwapAmounts quote={quote} />)
  expect(container.querySelectorAll('.fiat-amount')).toHaveLength(0)
  expect(container.textContent).toContain('WBTC')
  expect(container.textContent).toContain('cirBTC')
  expect(container.textContent).toContain('ETH')
})
