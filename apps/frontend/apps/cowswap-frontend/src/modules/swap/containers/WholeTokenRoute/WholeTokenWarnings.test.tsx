import { ReactNode } from 'react'

import { Percent } from '@cowprotocol/currency'

import { render, screen } from '@testing-library/react'

import { WholeTokenWarnings } from './WholeTokenWarnings.pure'

import { DirectQuote, MPS } from '../../services/wholeToken/router.service'

jest.mock('@cowprotocol/ui', () => ({
  InlineBanner: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  StatusColorVariant: { Alert: 'alert', Warning: 'warning' },
}))
jest.mock('modules/tradeWidgetAddons', () => ({ LOW_TIER_FEE: 10 }))
const quote = { budget: 10000n, netCost: 100n, gasCost: 1n, fees: [{ amount: 1n }], slippageBps: 50 } as DirectQuote

test('a large unused budget does not produce impact, fee or slippage warnings', () => {
  const { container } = render(<WholeTokenWarnings quote={quote} impact={new Percent(1, 1000)} loading={false} />)
  expect(container.textContent).toBe('')
})

test('shows actual impact, fees plus gas, and selected high slippage separately', () => {
  render(
    <WholeTokenWarnings
      quote={{ ...quote, gasCostInInput: 19n, slippageBps: 300 }}
      impact={new Percent(7, 100)}
      loading={false}
    />,
  )
  expect(screen.getByText(/Price impact is 7.00%/)).toBeTruthy()
  expect(screen.getByText(/Fees and estimated gas are 20.00%/)).toBeTruthy()
  expect(screen.getByText(/High slippage tolerance: 3%/)).toBeTruthy()
})

test('shows unavailable impact after loading finishes', () => {
  const { rerender } = render(<WholeTokenWarnings quote={quote} impact={undefined} loading />)
  expect(screen.queryByText(/Price impact is unavailable/)).toBeNull()
  rerender(<WholeTokenWarnings quote={quote} impact={undefined} loading={false} />)
  expect(screen.getByText(/Price impact is unavailable/)).toBeTruthy()
})

test('MPS sales measure costs in ETH and describe the minimum receive protection', () => {
  render(
    <WholeTokenWarnings
      quote={{
        ...quote,
        inputToken: MPS,
        netCost: 1n,
        buyAmount: 99n,
        gasCost: 9n,
        approvalGas: 10n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 0n,
        slippageBps: 300,
      }}
      impact={new Percent(1, 1000)}
      loading={false}
    />,
  )
  expect(screen.getByText(/20.00% of the expected output value/)).toBeTruthy()
  expect(screen.getByText(/The received amount can decrease to the quoted minimum/)).toBeTruthy()
})

test('stablecoin sales use output-denominated gas including approval costs', () => {
  render(
    <WholeTokenWarnings
      quote={{
        ...quote,
        inputToken: MPS,
        buyAmount: 9999999n,
        gasCost: 100000000000000n,
        gasCostInOutput: 1999999n,
        approvalGas: 50000n,
        maxFeePerGas: 1000000000n,
        maxPriorityFeePerGas: 0n,
      }}
      impact={new Percent(1, 1000)}
      loading={false}
    />,
  )
  expect(screen.getByText(/20.00% of the expected output value/)).toBeTruthy()
})
