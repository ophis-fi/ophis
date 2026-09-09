import { CurrencyAmount, Token } from '@cowprotocol/currency'

import { render } from '@testing-library/react'

import { ChangeApproveAmountModal } from './ChangeApproveAmountModal'
import { ChangeApproveAmountModalPure } from './ChangeApproveAmountModalPure'

import { useCustomApproveAmountInputState, useUpdateOrResetCustomApproveAmountInputState } from '../../state'

jest.mock('./ChangeApproveAmountModalPure', () => ({ ChangeApproveAmountModalPure: jest.fn(() => null) }))
jest.mock('../../state', () => ({
  useCustomApproveAmountInputState: jest.fn(),
  useUpdateOrResetCustomApproveAmountInputState: jest.fn(),
}))

const token = new Token(10, '0x1234567890123456789012345678901234567890', 6)
const ten = CurrencyAmount.fromRawAmount(token, '10000000')
const setState = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useUpdateOrResetCustomApproveAmountInputState).mockReturnValue([jest.fn(), jest.fn()])
})

it('keeps the displayed 10-token limit when confirming without editing it again', () => {
  jest.mocked(useCustomApproveAmountInputState).mockReturnValue({ amount: null, isInvalid: false })
  render(
    <ChangeApproveAmountModal
      setUserApproveAmountState={setState}
      initialAmountToApprove={ten}
      amountToSwap={CurrencyAmount.fromRawAmount(token, '9000000')}
    />,
  )
  jest.mocked(ChangeApproveAmountModalPure).mock.calls[0][0].onConfirm()
  expect(setState).toHaveBeenCalledWith({ isModalOpen: false, amountSetByUser: ten })
})

it('revalidates the entered limit when the quote increases while the editor is open', () => {
  jest.mocked(useCustomApproveAmountInputState).mockReturnValue({ amount: ten, isInvalid: false })
  const { rerender } = render(
    <ChangeApproveAmountModal setUserApproveAmountState={setState} initialAmountToApprove={ten} amountToSwap={ten} />,
  )
  rerender(
    <ChangeApproveAmountModal
      setUserApproveAmountState={setState}
      initialAmountToApprove={ten}
      amountToSwap={CurrencyAmount.fromRawAmount(token, '11000000')}
    />,
  )
  const props = jest.mocked(ChangeApproveAmountModalPure).mock.calls[1][0]
  expect(props.isInvalid).toBe(true)
  props.onConfirm()
  expect(setState).not.toHaveBeenCalled()
})
