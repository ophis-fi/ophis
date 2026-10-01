import { ReactNode } from 'react'

import { Currency, CurrencyAmount, Token } from '@cowprotocol/currency'

import { render, screen } from '@testing-library/react'

import { NearDirectSwap } from './NearDirectSwap.container'

const mockSetQuoteParams = jest.fn()
jest.mock('modules/tradeQuote', () => ({ useSetTradeQuoteParams: (params: unknown) => mockSetQuoteParams(params) }))

const mockInput = new Token(143, '0x1111111111111111111111111111111111111111', 6, 'USDC')
const mockSelection = { input: mockInput, output: null, amount: '0.123456789' }
jest.mock('jotai', () => ({ useAtomValue: () => ({ data: [] }) }))
jest.mock('./nearDirect.atoms', () => ({ nearTokensAtom: 'tokens' }))
jest.mock('./hooks/useNearSwapSelection', () => ({ useNearSwapSelection: () => ({ selection: mockSelection }) }))
jest.mock('./nearSwapAssets.utils', () => ({ findNearToken: jest.fn(), nearTokenPickerOptions: jest.fn() }))
jest.mock('modules/trade', () => ({
  TradeWidget: ({
    inputCurrencyInfo,
    slots,
  }: {
    inputCurrencyInfo: { amount: CurrencyAmount<Currency> }
    slots: { bottomContent(): ReactNode }
  }) => (
    <>
      <span data-testid="displayed">{inputCurrencyInfo.amount.toExact()}</span>
      {slots.bottomContent()}
    </>
  ),
}))
jest.mock('./NearSwapDetails.container', () => ({
  NearSwapDetails: ({ amount }: { amount: string }) => <span data-testid="quoted">{amount}</span>,
}))

it('quotes exactly the amount displayed after token precision is applied', () => {
  render(<NearDirectSwap initial={mockSelection} onExit={jest.fn()} />)
  expect(mockSetQuoteParams).toHaveBeenCalledWith({ amount: null })
  expect(screen.getByTestId('displayed').textContent).toBe('0.123456')
  expect(screen.getByTestId('quoted').textContent).toBe(screen.getByTestId('displayed').textContent)
})
