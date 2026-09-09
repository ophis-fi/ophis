import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { render } from '@testing-library/react'

import {
  MAX_APPROVE_AMOUNT,
  TradeApproveButton,
  TradeApproveToggle,
  useIsPartialApproveSelectedByUser,
} from 'modules/erc20Approve'

import { OrderPartialApprove } from './OrderPartialApprove'

jest.mock('modules/erc20Approve', () => ({
  MAX_APPROVE_AMOUNT: (1n << 256n) - 1n,
  ActiveOrdersWithAffectedPermit: () => null,
  PartialApproveAmountModal: () => null,
  TradeApproveButton: jest.fn(() => null),
  TradeApproveToggle: jest.fn(() => null),
  useIsPartialApprovalModeSelected: () => true,
  useIsPartialApproveSelectedByUser: jest.fn(),
  usePartialApproveAmountModalState: () => ({ isModalOpen: false }),
  useUpdatePartialApproveAmountModalState: () => jest.fn(),
}))

it('submits the selected finite or unlimited allowance while retaining the finite toggle amount', () => {
  const token = new Token(1, '0x1234567890123456789012345678901234567890', 6, 'USDC')
  const amount = CurrencyAmount.fromRawAmount(token, '10000000')
  const selected = jest.mocked(useIsPartialApproveSelectedByUser)
  selected.mockReturnValue(true)
  const { rerender } = render(<OrderPartialApprove amountToApprove={amount} isPartialApproveEnabledBySettings />)

  expect(jest.mocked(TradeApproveButton).mock.lastCall?.[0].amountToApprove.quotient.toString()).toBe('10000000')
  selected.mockReturnValue(false)
  rerender(<OrderPartialApprove amountToApprove={amount} isPartialApproveEnabledBySettings />)

  expect(jest.mocked(TradeApproveButton).mock.lastCall?.[0].amountToApprove.quotient.toString()).toBe(
    MAX_APPROVE_AMOUNT.toString(),
  )
  expect(jest.mocked(TradeApproveToggle).mock.lastCall?.[0].amountToApprove).toBe(amount)
})
