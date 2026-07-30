import { ReactNode } from 'react'

import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { fireEvent, render, screen } from '@testing-library/react'

import { NetReceivedRowContent } from './index'

// The lingui macro compiles <Trans> into the runtime '@lingui/react' Trans;
// render its source message so assertions read the same text as the code.
jest.mock('@lingui/react', () => ({
  ...jest.requireActual('@lingui/react'),
  Trans: ({ message, id }: { message?: string; id?: string }) => <>{message ?? id ?? ''}</>,
}))

jest.mock('@cowprotocol/ui', () => ({
  ...jest.requireActual('@cowprotocol/ui'),
  FiatAmount: ({ amount }: { amount: CurrencyAmount<Token> | null }) => (
    <span data-testid="fiat-amount">{amount ? `$${amount.toExact()}` : ''}</span>
  ),
  TokenAmount: ({ amount }: { amount: CurrencyAmount<Token> | null }) => (
    <span data-testid="token-amount">{amount ? `${amount.toExact()} ${amount.currency.symbol}` : ''}</span>
  ),
  HoverTooltip: ({
    children,
    content,
    onOpen,
  }: {
    children: ReactNode
    content: ReactNode
    onOpen?: () => void
  }) => (
    <span data-testid="tooltip-trigger" onMouseEnter={onOpen}>
      {children}
      <span data-testid="tooltip-content">{content}</span>
    </span>
  ),
}))

const USDC = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC', 'USD Coin')

function usd(raw: string): CurrencyAmount<Token> {
  return CurrencyAmount.fromRawAmount(USDC, raw)
}

const defaultProps = {
  netAmount: usd('997000000'),
  netUsd: usd('997000000'),
  grossUsd: usd('1000000000'),
  totalCostsUsd: usd('3000000'),
  userPaysGasOnTop: false,
  kind: 'receive' as const,
  feeLabel: 'Ophis fee',
  feeBps: 10,
}

describe('NetReceivedRowContent', () => {
  it('renders the receive label with the USD headline', () => {
    render(<NetReceivedRowContent {...defaultProps} />)

    expect(screen.getByText('You receive (net)')).toBeTruthy()
    // The tooltip mock renders its fiat rows first; the headline is the last one.
    const fiatAmounts = screen.getAllByTestId('fiat-amount').map((node) => node.textContent)
    expect(fiatAmounts[fiatAmounts.length - 1]).toBe('$997')
  })

  it('renders the pay label for buy orders', () => {
    render(<NetReceivedRowContent {...defaultProps} kind="pay" />)

    expect(screen.getByText('You pay (net)')).toBeTruthy()
  })

  it('falls back to the token amount when no USD price is known', () => {
    render(<NetReceivedRowContent {...defaultProps} netUsd={null} grossUsd={null} totalCostsUsd={null} />)

    expect(screen.getByTestId('token-amount').textContent).toBe('997 USDC')
  })

  it('falls back to the token amount when the widget hides USD values', () => {
    render(<NetReceivedRowContent {...defaultProps} hideUsdValues />)

    expect(screen.getByTestId('token-amount').textContent).toBe('997 USDC')
  })

  it('shows the + gas suffix only when the wallet pays gas on top', () => {
    const { rerender } = render(<NetReceivedRowContent {...defaultProps} />)
    expect(screen.queryByText('+ gas')).toBeNull()

    rerender(<NetReceivedRowContent {...defaultProps} userPaysGasOnTop />)
    expect(screen.getByText('+ gas')).toBeTruthy()
  })

  it('lists gross, costs and the fee bps in the tooltip', () => {
    render(<NetReceivedRowContent {...defaultProps} />)

    const tooltip = screen.getByTestId('tooltip-content').textContent || ''
    expect(tooltip).toContain('Before costs')
    expect(tooltip).toContain('Total costs')
    expect(tooltip).toContain('Ophis fee')
    expect(tooltip).toContain('10 bps')
    expect(tooltip).toContain('surplus')
  })

  it('hides unpriced tooltip rows instead of showing a partial sum', () => {
    render(<NetReceivedRowContent {...defaultProps} netUsd={null} grossUsd={null} totalCostsUsd={null} />)

    const tooltip = screen.getByTestId('tooltip-content').textContent || ''
    expect(tooltip).not.toContain('Before costs')
    expect(tooltip).not.toContain('Total costs')
  })

  it('fires the tooltip-open callback (net_received_tooltip_open)', () => {
    const onTooltipOpen = jest.fn()
    render(<NetReceivedRowContent {...defaultProps} onTooltipOpen={onTooltipOpen} />)

    fireEvent.mouseEnter(screen.getByTestId('tooltip-trigger'))

    expect(onTooltipOpen).toHaveBeenCalledTimes(1)
  })
})
